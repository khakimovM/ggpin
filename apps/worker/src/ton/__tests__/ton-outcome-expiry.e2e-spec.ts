import type { Prisma } from '@repo/db';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { Address, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import { observationJson, type ExpiryObservation } from '../ton-expiry';
import type { TonAccountState, TonChainWitness, TxPage } from '../ton-gateway';
import { witnessConflictNotice } from '../ton-notices';
import { TonOutcomeRepository, type TonOutcome } from '../ton-outcome.repository';
import { withTonFacts } from '../ton-row-locks';
import { buildW5Data } from '../ton-w5';
import { payRequest, rowsOf, tonFactOf } from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  WALLET_BALANCE,
  pinChain,
  useTonE2e,
} from './ton-e2e.harness';

// What one EXPIRY observation writes on the real database (review MJ1, D-60 (2)): the first is
// kept on the attempt, one inside the gap writes nothing, a confirming one writes transfer EXPIRED
// + attempt FAILED + the proof { first, second }; under NEEDS_REVIEW the attempt stays UNKNOWN.
// Audit L-3: a kept first of another transfer is no first. Review m3: an expiry witness that sees
// our message sends the order to review with a critical alert instead.

const t = useTonE2e();
const GAP_SEC = 30;

interface TransferRow {
  readonly id: string;
  readonly extMsgHash: string;
  readonly validUntil: Date;
  readonly seqno: number;
}

/** An observation `laterSec` after the earliest one the database guard accepts. */
function observation(transfer: TransferRow, laterSec: number): ExpiryObservation {
  const validUntilMs = transfer.validUntil.getTime();
  return {
    transferId: transfer.id,
    extMsgHash: transfer.extMsgHash,
    validUntilMs,
    chainTime: Math.floor(validUntilMs / 1_000) + TON_NOT_SENT_MARGIN_MS / 1_000 + 1 + laterSec,
    atMs: validUntilMs + TON_NOT_SENT_MARGIN_MS + laterSec * 1_000,
    seqno: transfer.seqno,
    lastTxLt: 0n,
  };
}

const seen = (o: ExpiryObservation): TonOutcome => ({
  kind: 'EXPIRY_SEEN',
  observation: o,
  gapSec: GAP_SEC,
});

/** A payout whose message was lost and whose worker died right after broadcasting it. */
async function brokenOff() {
  pinChain(t.gateway, SIGN_AT_SEC);
  t.gateway.nextSend('LOSE');
  t.ton.hooks.afterBroadcastFn = () => Promise.reject(new Error('the worker died here'));
  const fixture = await t.order();
  await expect(t.ton.sender.pay(payRequest(fixture))).rejects.toThrow('the worker died here');
  t.ton.hooks.afterBroadcastFn = () => Promise.resolve();
  const rows = await rowsOf(t.db, fixture);
  if (rows.transfer === null) throw new Error('the payout stored no transfer');
  const outcomes = t.ton.moduleRef.get(TonOutcomeRepository);
  return { fixture, transfer: rows.transfer, outcomes, rows };
}

describe('TON outcome writes: EXPIRY observations (D-60 (2), review MJ1)', () => {
  it('first written; inside the gap nothing; the confirming one: EXPIRED + FAILED + { first, second }', async () => {
    const { fixture, transfer, outcomes, rows } = await brokenOff();
    expect([rows.transfer?.status, rows.order.status]).toEqual(['BROADCAST', 'PROCESSING']);
    const first = observation(transfer, 0);
    expect((await outcomes.apply(transfer.id, seen(first))).applied).toBe(true);
    const kept = await rowsOf(t.db, fixture);
    expect([kept.transfer?.status, kept.attempt.status]).toEqual([
      'BROADCAST',
      rows.attempt.status,
    ]);
    expect(tonFactOf(kept.attempt.response, 'expiry')).toEqual({ first: observationJson(first) });
    // 1 ms short of the gap, with a later chain time: nothing is written.
    const early = { ...observation(transfer, GAP_SEC), atMs: first.atMs + GAP_SEC * 1_000 - 1 };
    expect((await outcomes.apply(transfer.id, seen(early))).applied).toBe(false);
    expect(await rowsOf(t.db, fixture)).toEqual(kept);
    const second = observation(transfer, GAP_SEC);
    expect((await outcomes.apply(transfer.id, seen(second))).applied).toBe(true);
    const done = await rowsOf(t.db, fixture);
    expect(done.transfer?.status).toBe('EXPIRED');
    expect(done.attempt).toMatchObject({ status: 'FAILED', error: 'TON_EXPIRED' });
    expect(tonFactOf(done.attempt.response, 'expiry')).toEqual({
      first: observationJson(first),
      second: observationJson(second),
    });
    expect(done.order.status).toBe('PROCESSING');
  });

  it('under NEEDS_REVIEW: the transfer becomes EXPIRED, the attempt stays UNKNOWN, the order stays', async () => {
    const { fixture, transfer, outcomes } = await brokenOff();
    await outcomes.apply(transfer.id, { kind: 'TIMEOUT' });
    const reviewed = await rowsOf(t.db, fixture);
    expect([reviewed.order.status, reviewed.attempt.status]).toEqual(['NEEDS_REVIEW', 'UNKNOWN']);
    const first = observation(transfer, 0);
    const second = observation(transfer, GAP_SEC);
    expect((await outcomes.apply(transfer.id, seen(first))).applied).toBe(true);
    expect((await outcomes.apply(transfer.id, seen(second))).applied).toBe(true);
    const done = await rowsOf(t.db, fixture);
    expect(done.transfer?.status).toBe('EXPIRED');
    expect(done.attempt.status).toBe('UNKNOWN');
    expect(done.order.status).toBe('NEEDS_REVIEW');
    expect(tonFactOf(done.attempt.response, 'expiry')).toEqual({
      first: observationJson(first),
      second: observationJson(second),
    });
    expect(tonFactOf(done.attempt.response, 'timeout')).toBe(true);
  });

  it('audit L-3: a kept first of another transfer is no first; the next look becomes the first', async () => {
    const { fixture, transfer, outcomes, rows } = await brokenOff();
    const forged = { ...observation(transfer, 0), transferId: 'cm0anothertransfer' };
    const forgedFirst: Prisma.InputJsonObject = { expiry: { first: observationJson(forged) } };
    await t.db.fulfillmentAttempt.update({
      where: { id: fixture.attemptId },
      data: { response: withTonFacts(rows.attempt.response, forgedFirst) },
    });
    const next = observation(transfer, GAP_SEC);
    expect((await outcomes.apply(transfer.id, seen(next))).applied).toBe(true);
    const kept = await rowsOf(t.db, fixture);
    expect(kept.transfer?.status).toBe('BROADCAST');
    expect(tonFactOf(kept.attempt.response, 'expiry')).toEqual({ first: observationJson(next) });
    expect(
      (await outcomes.apply(transfer.id, seen(observation(transfer, 2 * GAP_SEC)))).applied,
    ).toBe(true);
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('EXPIRED');
  });
});

/** The whole primary provider answers from before our transaction; the chain really has it. */
class FrozenPrimaryGateway extends FakeTonGateway {
  frozen: Buffer | null = null;

  override async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await super.getAccountState(address);
    return this.frozen === null ? real : { ...real, data: this.frozen, lastTx: null };
  }

  override async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    const real = await super.getTransactions(address, page);
    return this.frozen === null ? real : [];
  }

  /** An independent source: the chain as it is. */
  truth(): TonChainWitness {
    return {
      getAccountState: (address) => super.getAccountState(address),
      getTransactions: (address, page) => super.getTransactions(address, page),
    };
  }
}

describe('TON outcome writes: an expiry witness contradicts the primary source (review m3)', () => {
  it('the witness finds our message: REVIEW, attempt UNKNOWN, a critical alert, never EXPIRED', async () => {
    const wallet = t.newWallet();
    const gateway = new FrozenPrimaryGateway({ production: false, dryRun: true });
    gateway.registerWallet(wallet, WALLET_BALANCE);
    const ton = await t.boot({ wallet, gateway, witnesses: [gateway.truth()] });
    const fixture = await t.order();
    const request = payRequest(fixture);
    pinChain(gateway, SIGN_AT_SEC);
    ton.hooks.afterBroadcastFn = () => {
      gateway.frozen = buildW5Data(wallet.own, 0).toBoc();
      pinChain(gateway, PAST_VALID_SEC);
      return Promise.resolve();
    };
    const result = await ton.sender.pay(request);
    expect(result.status).toBe('REVIEW');
    const rows = await rowsOf(t.db, fixture);
    expect([rows.order.status, rows.attempt.status, rows.transfer?.status]).toEqual([
      'NEEDS_REVIEW',
      'UNKNOWN',
      'BROADCAST',
    ]);
    expect(tonFactOf(rows.attempt.response, 'witnessConflict')).toEqual({
      detail: 'FOUND',
      witness: 0,
    });
    expect(tonFactOf(rows.attempt.response, 'expiry')).toBeNull();
    expect(gateway.callCount('sendBoc')).toBe(1);
    expect(gateway.balanceOf(Address.parseRaw(request.toAddress))).toBe(request.amountNano);
    const transferId = rows.transfer?.id ?? '';
    await t.expectJobs([witnessConflictNotice(transferId)]);
  });
});
