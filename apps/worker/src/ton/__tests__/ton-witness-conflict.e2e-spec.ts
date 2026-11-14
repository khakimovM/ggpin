import { setTimeout as sleep } from 'node:timers/promises';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import type { Address, Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import { TonChainReader } from '../ton-chain-reader';
import type { TonAccountState, TonChainWitness, TxPage } from '../ton-gateway';
import { witnessConflictNotice } from '../ton-notices';
import { TonOutcomeRepository, type TonOutcome } from '../ton-outcome.repository';
import { buildW5Data, type W5Data } from '../ton-w5';
import { payRequest, rowsOf, tonFactOf } from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  TEST_TIMING,
  WALLET_BALANCE,
  pinChain,
  useTonE2e,
} from './ton-e2e.harness';

// Review RR2-4: once an expiry witness contradicted "not sent" (WITNESS_CONFLICT, review m3), the
// transfer is never written EXPIRED again, not even after the witness agrees later: EXPIRED is the
// TON_NOT_SENT proof that pays again or refunds, and one of the two sources has already lied. The
// conflict kept on the attempt (`ton.witnessConflict`) bars it in the write layer for good (a
// restart and the reconciler included); the reader keeps answering WITNESS_CONFLICT in memory.
// The owner's alert comes from that kept fact, so a lost enqueue is sent again by the next look.

const t = useTonE2e();
/** More than the test gap (TEST_TIMING.expiryGapSec), so two looks could prove an expiry. */
const MARGIN_SEC = TON_NOT_SENT_MARGIN_MS / 1_000;
const PAST_GAP_MS = TEST_TIMING.expiryGapSec * 1_000 + 300;

/** Reads the same chain; its first `conflicts` account states show the seqno as used (moved). */
class FlipWitness implements TonChainWitness {
  conflicts = 1;

  constructor(
    private readonly chain: FakeTonGateway,
    private readonly own: W5Data,
  ) {}

  async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await this.chain.getAccountState(address);
    if (this.conflicts <= 0) return real;
    this.conflicts -= 1;
    return { ...real, data: buildW5Data(this.own, 1).toBoc() };
  }

  getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    return this.chain.getTransactions(address, page);
  }
}

describe('TON: an expiry witness conflict bars EXPIRED for good (review RR2-4)', () => {
  it('SEQNO_MOVED once, the witness agrees later: never EXPIRED, attempt UNKNOWN, order NEEDS_REVIEW', async () => {
    const wallet = t.newWallet();
    const gateway = new FakeTonGateway({ production: false, dryRun: true });
    gateway.registerWallet(wallet, WALLET_BALANCE);
    const ton = await t.boot({
      wallet,
      gateway,
      witnesses: [new FlipWitness(gateway, wallet.own)],
    });
    const fixture = await t.order();
    pinChain(gateway, SIGN_AT_SEC);
    gateway.nextSend('LOSE');
    ton.hooks.afterBroadcastFn = () => {
      pinChain(gateway, PAST_VALID_SEC);
      return Promise.resolve();
    };
    expect((await ton.sender.pay(payRequest(fixture))).status).toBe('REVIEW');
    const paid = await rowsOf(t.db, fixture);
    const transferId = paid.transfer?.id ?? '';
    const conflict = { detail: 'SEQNO_MOVED', witness: 0 };
    expect(tonFactOf(paid.attempt.response, 'witnessConflict')).toEqual(conflict);
    const alert = witnessConflictNotice(transferId);
    await t.expectJobs([alert]);

    // The enqueue of the alert was lost: the next look (same process) sends it again.
    await t.dropJobs([alert]);
    expect((await ton.confirm.check(transferId)).verdict?.kind).toBe('WITNESS_CONFLICT');
    await t.expectJobs([alert]);

    // A restart (the reader's memory is gone) and the witness now agrees: two looks a gap apart.
    ton.moduleRef.get(TonChainReader).forget(transferId);
    await t.dropJobs([alert]);
    const first = await ton.confirm.check(transferId);
    await sleep(PAST_GAP_MS);
    const second = await ton.confirm.check(transferId);
    expect([first.verdict?.kind, second.verdict?.kind]).toEqual(['EXPIRY_SEEN', 'EXPIRY_SEEN']);
    const rows = await rowsOf(t.db, fixture);
    expect([rows.transfer?.status, rows.attempt.status, rows.order.status]).toEqual([
      'BROADCAST',
      'UNKNOWN',
      'NEEDS_REVIEW',
    ]);
    expect(tonFactOf(rows.attempt.response, 'witnessConflict')).toEqual(conflict);
    expect(tonFactOf(rows.attempt.response, 'expiry')).toBeNull();
    expect(gateway.callCount('sendBoc')).toBe(1);
    await t.expectJobs([alert]);
  });

  it('the write layer alone: after WITNESS_CONFLICT two consistent EXPIRY observations write nothing', async () => {
    const wallet = t.newWallet();
    const gateway = new FakeTonGateway({ production: false, dryRun: true });
    gateway.registerWallet(wallet, WALLET_BALANCE);
    const ton = await t.boot({ wallet, gateway });
    const fixture = await t.order();
    pinChain(gateway, SIGN_AT_SEC);
    gateway.nextSend('LOSE');
    ton.hooks.afterBroadcastFn = () => Promise.reject(new Error('the worker died here'));
    await expect(ton.sender.pay(payRequest(fixture))).rejects.toThrow('the worker died here');
    const before = await rowsOf(t.db, fixture);
    const transfer = before.transfer;
    if (transfer === null) throw new Error('the payout stored no transfer');
    const outcomes = ton.moduleRef.get(TonOutcomeRepository);
    const conflict: TonOutcome = { kind: 'WITNESS_CONFLICT', detail: 'SEQNO_MOVED', witness: 0 };
    const conflicted = await outcomes.apply(transfer.id, conflict);
    expect([conflicted.applied, conflicted.state.witnessConflict]).toEqual([true, true]);
    const reviewed = await rowsOf(t.db, fixture);
    const validUntilMs = transfer.validUntil.getTime();
    const look = (laterSec: number): TonOutcome => ({
      kind: 'EXPIRY_SEEN',
      gapSec: TEST_TIMING.expiryGapSec,
      observation: {
        transferId: transfer.id,
        extMsgHash: transfer.extMsgHash,
        validUntilMs,
        chainTime: Math.floor(validUntilMs / 1_000) + MARGIN_SEC + 1 + laterSec,
        atMs: validUntilMs + TON_NOT_SENT_MARGIN_MS + laterSec * 1_000,
        seqno: transfer.seqno,
        lastTxLt: 0n,
      },
    });
    expect((await outcomes.apply(transfer.id, look(0))).applied).toBe(false);
    expect((await outcomes.apply(transfer.id, look(30))).applied).toBe(false);
    expect(await rowsOf(t.db, fixture)).toEqual(reviewed);
    expect(reviewed.transfer?.status).toBe('BROADCAST');
  });
});
