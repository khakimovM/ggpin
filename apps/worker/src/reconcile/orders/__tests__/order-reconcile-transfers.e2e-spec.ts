import { setTimeout as sleep } from 'node:timers/promises';
import { rowsOf, tonFactOf } from '../../../ton/__tests__/ton-e2e.fixtures';
import { PAST_VALID_SEC, pinChain } from '../../../ton/__tests__/ton-e2e.harness';
import { countsOf, useReconcileE2e } from './reconcile-e2e.harness';

// Phase 5 S9 (D-64 (1), (2)) on the real database: a NEEDS_REVIEW order whose payout the chain
// later decides is resolved by the reconciler with the TON module's own evidence, through
// `resolveNeedsReview` only, and the effects follow the commit with stable ids.

const r = useReconcileE2e();
const { t } = r;
/** More than TEST_TIMING.expiryGapSec, and a later chain second, between two observations. */
const PAST_GAP_MS = 1_500;

describe('order reconciler: transfers and NEEDS_REVIEW proofs (S9c)', () => {
  it('a timed-out payout lands later: transfer CONFIRMED, order DELIVERED by TON_TX', async () => {
    const rec = await r.boot();
    const fixture = await r.timedOut(rec, 'HOLD');
    t.gateway.releaseHeld();

    const report = await rec.service.tick();
    expect(countsOf(report, 'transfers')).toEqual({ confirmed: 1 });
    expect(countsOf(report, 'review')).toEqual({ delivered: 1 });
    const { order, audits, ledger } = await r.moneyOf(fixture.orderId);
    expect(order.status).toBe('DELIVERED');
    expect(order.deliveredAt).not.toBeNull();
    expect(ledger.map((e) => e.kind)).toEqual(['PURCHASE']);
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit?.actorType).toBe('SYSTEM');
    expect(audit?.after).toMatchObject({ resolver: 'reconciler', proof: { kind: 'TON_TX' } });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.attempt.status).toBe('CONFIRMED');
    expect(rows.transfer?.status).toBe('CONFIRMED');
    // After the commit: the customer hears, the owner gets reviewResolved <orderId>_<auditId>.
    expect(await r.hasJob({ kind: 'ORDER_DELIVERED', refId: fixture.orderId })).toBe(true);
    const refId = `${fixture.orderId}_${audit?.id ?? ''}`;
    expect(await r.hasJob({ kind: 'OWNER_ALERT', alert: 'reviewResolved', refId })).toBe(true);
    // Never an operator alert for the reconciler's own decision, never a second payment.
    expect(
      await r.hasJob({ kind: 'OWNER_ALERT', alert: 'adminAction', refId: audit?.id ?? '' }),
    ).toBe(false);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('a lost message: two observations -> EXPIRED -> FAILED + REFUND of exactly the PURCHASE', async () => {
    const rec = await r.boot();
    const fixture = await r.timedOut(rec, 'LOSE');
    await r.cacheBalance(fixture.userId);
    pinChain(t.gateway, PAST_VALID_SEC);

    // First tick: the first observation is kept, nothing is decided yet.
    const first = await rec.service.tick();
    expect(countsOf(first, 'transfers')).toEqual({ waiting: 1 });
    expect(countsOf(first, 'review')).toEqual({ 'skip:NOT_PROVABLE': 1 });
    const kept = await rowsOf(t.db, fixture);
    expect(kept.transfer?.status).toBe('BROADCAST');
    expect(tonFactOf(kept.attempt.response, 'expiry')).toHaveProperty('first');
    expect((await r.moneyOf(fixture.orderId)).order.status).toBe('NEEDS_REVIEW');
    expect(await r.cached(fixture.userId)).toBe(true);

    await sleep(PAST_GAP_MS);
    const second = await rec.service.tick();
    expect(countsOf(second, 'transfers')).toEqual({ expired: 1 });
    expect(countsOf(second, 'review')).toEqual({ refunded: 1 });
    const { order, ledger, audits } = await r.moneyOf(fixture.orderId);
    expect(order).toMatchObject({ status: 'REFUNDED', statusReason: 'CONFIRM_TIMEOUT' });
    expect(ledger.map((e) => e.kind)).toEqual(['PURCHASE', 'REFUND']);
    const [purchase, refund] = ledger;
    expect(refund?.amountTiyin).toBe(-(purchase?.amountTiyin ?? 0n));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toMatchObject({
      resolver: 'reconciler',
      proof: { kind: 'TON_NOT_SENT', checkedSeqno: kept.transfer?.seqno },
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.attempt.status).toBe('FAILED');
    expect(rows.transfer?.status).toBe('EXPIRED');
    expect(await r.cached(fixture.userId)).toBe(false);
    expect(await r.hasJob({ kind: 'ORDER_REFUNDED', refId: fixture.orderId })).toBe(true);
    const refId = `${fixture.orderId}_${audits[0]?.id ?? ''}`;
    expect(await r.hasJob({ kind: 'OWNER_ALERT', alert: 'reviewResolved', refId })).toBe(true);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('a second tick and a restarted worker change nothing (idempotent replay)', async () => {
    const rec = await r.boot();
    const fixture = await r.timedOut(rec, 'LOSE');
    pinChain(t.gateway, PAST_VALID_SEC);
    await rec.service.tick();
    await sleep(PAST_GAP_MS);
    expect(countsOf(await rec.service.tick(), 'review')).toEqual({ refunded: 1 });
    const before = await r.moneyOf(fixture.orderId);
    const jobs = await r.jobIdsLike(`order-${fixture.orderId}`);

    const again = await rec.service.tick();
    const restarted = await (await r.boot()).service.tick();
    for (const report of [again, restarted]) {
      expect(countsOf(report, 'transfers')).toEqual({});
      expect(countsOf(report, 'review')).toEqual({});
    }
    expect(await r.moneyOf(fixture.orderId)).toEqual(before);
    expect(await r.jobIdsLike(`order-${fixture.orderId}`)).toEqual(jobs);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });
});
