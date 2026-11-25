import { Address, type Transaction } from '@ton/core';
import {
  payRequest,
  rowsOf,
  tonFactOf,
  untilSecondLook,
} from '../../../ton/__tests__/ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  TEST_TIMING,
  pinChain,
} from '../../../ton/__tests__/ton-e2e.harness';
import type { FakeTonGateway } from '../../../ton/fake-ton.gateway';
import type { TonAccountState, TonChainWitness, TxPage } from '../../../ton/ton-gateway';
import { buildW5Data, type W5Data } from '../../../ton/ton-w5';
import { episodeRef } from '../guard-ref';
import { writeTonFact } from './reconcile-e2e.fakes';
import {
  countsOf,
  useReconcileE2e,
  type ReconcileE2e,
  type Reconciler,
} from './reconcile-e2e.harness';

// Plan §4.4 on the real database: without a proof the reconciler writes nothing. No CONFIRMED and
// no expiry yet, one observation only, a witness conflict, CONSUMED_UNMATCHED (only its alert) and
// BOUNCED (the owner's TON_BOUNCED) all leave the order NEEDS_REVIEW, the ledger and the audit
// log untouched, and nothing is ever sent again.

const r = useReconcileE2e();
const { t } = r;

/** Reads the same chain; every account state it shows has the seqno as used (moved). */
class MovedSeqnoWitness implements TonChainWitness {
  constructor(
    private readonly chain: FakeTonGateway,
    private readonly own: W5Data,
  ) {}

  async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await this.chain.getAccountState(address);
    return { ...real, data: buildW5Data(this.own, 1).toBoc() };
  }

  getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    return this.chain.getTransactions(address, page);
  }
}

/** A payout whose seqno was used by another message (CONSUMED_UNMATCHED: NEEDS_REVIEW). */
async function consumedUnmatched(rec: Reconciler) {
  rec.hooks.afterStoredFn = () => {
    t.gateway.consumeSeqnoForeign(t.wallet.address);
    return Promise.resolve();
  };
  const fixture = await r.order();
  expect(await rec.sender.pay(payRequest(fixture))).toMatchObject({
    status: 'REVIEW',
    transferStatus: 'CONSUMED_UNMATCHED',
  });
  return { fixture, transferId: (await rowsOf(t.db, fixture)).transfer?.id ?? '' };
}

function reminder(transferId: string, nowMs: number) {
  const refId = episodeRef(transferId, 'cu', nowMs) ?? '';
  return { kind: 'OWNER_ALERT', alert: 'tonConsumedUnmatched', refId } as const;
}

/** Nothing of the order moved: still NEEDS_REVIEW, PURCHASE only, no resolution audit row. */
async function untouched(e2e: ReconcileE2e, orderId: string): Promise<void> {
  const { order, ledger, audits } = await e2e.moneyOf(orderId);
  expect(order.status).toBe('NEEDS_REVIEW');
  expect(ledger.map((entry) => entry.kind)).toEqual(['PURCHASE']);
  expect(audits).toEqual([]);
  expect(await e2e.hasJob({ kind: 'ORDER_REFUNDED', refId: orderId })).toBe(false);
  expect(await e2e.hasJob({ kind: 'ORDER_DELIVERED', refId: orderId })).toBe(false);
}

describe('order reconciler: no proof, nothing written (S9c, plan §4.4)', () => {
  it('no CONFIRMED and no expiry: the transfer is only looked at', async () => {
    const rec = await r.boot();
    const fixture = await r.timedOut(rec, 'HOLD');
    const report = await rec.service.tick();
    expect(countsOf(report, 'transfers')).toEqual({ waiting: 1 });
    expect(countsOf(report, 'review')).toEqual({ 'skip:NOT_PROVABLE': 1 });
    await untouched(r, fixture.orderId);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('one observation only: the first is kept, no EXPIRED, no refund', async () => {
    const rec = await r.boot();
    const fixture = await r.timedOut(rec, 'LOSE');
    pinChain(t.gateway, PAST_VALID_SEC);
    await rec.service.tick();
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('BROADCAST');
    expect(tonFactOf(rows.attempt.response, 'expiry')).not.toHaveProperty('second');
    await untouched(r, fixture.orderId);
  });

  it('a witness contradicted "not sent": never EXPIRED, never refunded, however often it looks', async () => {
    const rec = await r.boot({ witnesses: [new MovedSeqnoWitness(t.gateway, t.wallet.own)] });
    const fixture = await r.timedOut(rec, 'LOSE');
    pinChain(t.gateway, PAST_VALID_SEC);
    for (let tick = 0; tick < 3; tick += 1) await rec.service.tick();
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('BROADCAST');
    expect(tonFactOf(rows.attempt.response, 'witnessConflict')).not.toBeNull();
    await untouched(r, fixture.orderId);
  });

  it('CONSUMED_UNMATCHED: only the tonConsumedUnmatched reminder (one per hour), the owner decides', async () => {
    const rec = await r.boot();
    const { fixture, transferId } = await consumedUnmatched(rec);
    const report = await rec.service.tick();
    expect(countsOf(report, 'review')).toEqual({ consumedUnmatched: 1 });
    expect(await r.hasJob(reminder(transferId, report.nowMs))).toBe(true);
    await untouched(r, fixture.orderId);
  });

  it('I-2: the CU reminder comes even when another fact (a witness conflict) stops the decision', async () => {
    const rec = await r.boot();
    const { fixture, transferId } = await consumedUnmatched(rec);
    await writeTonFact(t.db, fixture.attemptId, 'witnessConflict', { test: true });
    const report = await rec.service.tick();
    expect(countsOf(report, 'review')).toEqual({ consumedUnmatched: 1 });
    expect(await r.hasJob(reminder(transferId, report.nowMs))).toBe(true);
    await untouched(r, fixture.orderId);
  });

  it('BOUNCED: left to the owner (TON_BOUNCED), nothing written', async () => {
    const rec = await r.boot();
    const fixture = await r.order();
    const request = payRequest(fixture);
    t.gateway.destination(Address.parseRaw(request.toAddress), 'BOUNCE');
    expect(await rec.sender.pay(request)).toMatchObject({ transferStatus: 'BOUNCED' });
    const report = await rec.service.tick();
    expect(countsOf(report, 'review')).toEqual({ 'skip:NOT_PROVABLE': 1 });
    await untouched(r, fixture.orderId);
  });

  it("a proof naming another order's transfer is refused (MISMATCH) and nothing is written", async () => {
    const rec = await r.boot();
    const a = await r.timedOut(rec, 'LOSE');
    pinChain(t.gateway, PAST_VALID_SEC);
    await rec.confirm.check(a.transferId);
    await untilSecondLook(t.db, a.attemptId, TEST_TIMING.expiryGapSec);
    expect((await rec.confirm.check(a.transferId)).state.transferStatus).toBe('EXPIRED');
    pinChain(t.gateway, SIGN_AT_SEC);
    const b = await r.timedOut(rec, 'LOSE');
    const transferB = (await rowsOf(t.db, b)).transfer;
    if (transferB === null) throw new Error('no transfer');
    const proofOfB = {
      kind: 'TON_NOT_SENT',
      extMsgHash: transferB.extMsgHash,
      walletAddress: transferB.walletAddress,
      seqno: transferB.seqno,
      validUntil: transferB.validUntil.toISOString(),
      checkedSeqno: transferB.seqno,
      checkedAt: new Date(transferB.validUntil.getTime() + 61_000).toISOString(),
      reason: 'test: a proof of another order',
    } as const;
    await expect(
      rec.resolver.resolve(a.orderId, { to: 'FAILED', proof: proofOfB }, 'any'),
    ).rejects.toMatchObject({ name: 'ReviewProofError', problem: 'MISMATCH' });
    await untouched(r, a.orderId);
    await untouched(r, b.orderId);
  });
});
