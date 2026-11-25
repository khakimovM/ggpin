import { setTimeout as sleep } from 'node:timers/promises';
import { parseMajor } from '@repo/shared';
import { RedisLockStore } from '../../../bank-feed/client/leader-lock';
import { orderLockKey } from '../../../fulfillment/order-lock';
import {
  type PayoutFixture,
  payRequest,
  rowsOf,
  tonFactOf,
  untilSecondLook,
} from '../../../ton/__tests__/ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  TEST_TIMING,
  WALLET_BALANCE,
  pinChain,
} from '../../../ton/__tests__/ton-e2e.harness';
import { countsOf, useReconcileE2e, type Reconciler } from './reconcile-e2e.harness';

// Phase 5 S9i acceptance (plan §S9i, D-64 (1)-(2), rules/70), only what no other e2e proves
// through the reconciler's TICK (the coverage map is in the S9i report):
// - SUSPECT (the wallet skipped the payout) is never resolved by a tick, with or without a witness;
//   with one the late step writes ONCHAIN_FAILED, and that is never resolved either (owner only);
// - three reconcilers at once on one provable refund: exactly one `REFUND ORDER/<id>` entry and the
//   customer's balance (SUM of the ledger) back where it was before the purchase;
// - criterion 3 continued: the worker died right after the broadcast, its order lease is left in
//   Redis and its job is gone. The tick keeps off the order (and off the chain) while the lease
//   lives; once its TTL ends, the next tick finds the landed payout and delivers it, nothing sent
//   twice, no money moved.

const r = useReconcileE2e();
const { t } = r;

/** The customer's wallet balance: SUM of every ledger entry of the user (CLAUDE.md §5.2). */
async function balanceOf(userId: string): Promise<bigint> {
  const sum = await t.db.ledgerEntry.aggregate({ where: { userId }, _sum: { amountTiyin: true } });
  return sum._sum.amountTiyin ?? 0n;
}

/** The wallet skipped the payout (balance gone after signing): SUSPECT NO_OUT_MESSAGE, review. */
async function suspectPayout(rec: Reconciler): Promise<PayoutFixture & { transferId: string }> {
  rec.hooks.afterStoredFn = () => {
    t.gateway.setBalance(t.wallet.address, parseMajor('TON', '0.01'));
    return Promise.resolve();
  };
  const fixture = await r.order();
  const result = await rec.sender.pay(payRequest(fixture));
  rec.hooks.afterStoredFn = () => Promise.resolve();
  t.gateway.setBalance(t.wallet.address, WALLET_BALANCE);
  expect(result).toMatchObject({ status: 'REVIEW', transferStatus: 'BROADCAST' });
  const rows = await rowsOf(t.db, fixture);
  expect(tonFactOf(rows.attempt.response, 'suspect')).toMatchObject({ detail: 'NO_OUT_MESSAGE' });
  return { ...fixture, transferId: rows.transfer?.id ?? '' };
}

/** Still NEEDS_REVIEW, the PURCHASE alone, no resolution row, no customer notice. */
async function stillWithOwner(orderId: string): Promise<void> {
  const { order, ledger, audits } = await r.moneyOf(orderId);
  expect(order.status).toBe('NEEDS_REVIEW');
  expect(ledger.map((entry) => entry.kind)).toEqual(['PURCHASE']);
  expect(audits).toEqual([]);
  expect(await r.hasJob({ kind: 'ORDER_REFUNDED', refId: orderId })).toBe(false);
  expect(await r.hasJob({ kind: 'ORDER_DELIVERED', refId: orderId })).toBe(false);
}

describe('S9i acceptance: proofless moves refused through the tick', () => {
  it('SUSPECT without a witness: every tick skips it (SUSPECT), the transfer stays unresolved', async () => {
    const rec = await r.boot();
    const fixture = await suspectPayout(rec);
    for (let tick = 0; tick < 3; tick += 1) {
      const report = await rec.service.tick();
      expect(countsOf(report, 'review')).toEqual({ 'skip:SUSPECT': 1 });
    }
    expect((await rowsOf(t.db, fixture)).transfer).toMatchObject({
      status: 'BROADCAST',
      txHash: null,
    });
    await stillWithOwner(fixture.orderId);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('SUSPECT with an agreeing witness: the tick writes ONCHAIN_FAILED, and still never resolves it', async () => {
    const rec = await r.boot({ witnesses: [t.gateway.freshConnection()] });
    const fixture = await suspectPayout(rec);
    const first = await rec.service.tick();
    expect(countsOf(first, 'late')).toMatchObject({ ONCHAIN_FAILED: 1 });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('ONCHAIN_FAILED');
    expect(tonFactOf(rows.attempt.response, 'onchainFailed')).toMatchObject({ outMsgCount: 0 });
    expect(rows.attempt.status).toBe('UNKNOWN');
    for (let tick = 0; tick < 2; tick += 1) {
      const report = await rec.service.tick();
      expect(countsOf(report, 'review')).toEqual({ 'skip:SUSPECT': 1 });
      expect(countsOf(report, 'late')).not.toHaveProperty('ONCHAIN_FAILED');
    }
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('ONCHAIN_FAILED');
    await stillWithOwner(fixture.orderId);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });
});

describe('S9i acceptance: parallel reconcilers and the ledger', () => {
  it('three reconcilers at once (the lease granted to all): one REFUND ORDER/<id>, the balance restored', async () => {
    const recs = [
      await r.boot({ grantingLock: true }),
      await r.boot({ grantingLock: true }),
      await r.boot({ grantingLock: true }),
    ];
    const [first] = recs;
    if (first === undefined) throw new Error('no reconciler');
    const fixture = await r.timedOut(first, 'LOSE');
    const beforePurchase =
      (await balanceOf(fixture.userId)) -
      ((await r.moneyOf(fixture.orderId)).ledger[0]?.amountTiyin ?? 0n);
    await r.cacheBalance(fixture.userId);
    pinChain(t.gateway, PAST_VALID_SEC);
    await first.confirm.check(fixture.transferId);
    await untilSecondLook(t.db, fixture.attemptId, TEST_TIMING.expiryGapSec);
    expect((await first.confirm.check(fixture.transferId)).state.transferStatus).toBe('EXPIRED');

    const reports = await Promise.all(recs.map((rec) => rec.service.tick()));
    const refunded = reports.map((report) => countsOf(report, 'review')['refunded'] ?? 0);
    expect(refunded.reduce((a, b) => a + b, 0)).toBe(1);

    const refunds = await t.db.ledgerEntry.findMany({
      where: { refType: 'ORDER', refId: fixture.orderId, kind: 'REFUND' },
      select: { userId: true, amountTiyin: true },
    });
    const { ledger, audits, order } = await r.moneyOf(fixture.orderId);
    const purchase = ledger[0]?.amountTiyin ?? 0n;
    expect(refunds).toEqual([{ userId: fixture.userId, amountTiyin: -purchase }]);
    expect(order.status).toBe('REFUNDED');
    expect(audits).toHaveLength(1);
    expect(await balanceOf(fixture.userId)).toBe(beforePurchase);
    expect(await r.cached(fixture.userId)).toBe(false);
    expect(
      await t.db.orderEvent.count({ where: { orderId: fixture.orderId, to: 'REFUNDED' } }),
    ).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });
});

describe('S9i acceptance: the worker died, then the reconciler (criterion 3 continued)', () => {
  it('a dead lease keeps the tick off the order; after its TTL the landed payout is delivered once', async () => {
    const rec = await r.boot();
    const fixture = await r.order();
    rec.hooks.afterBroadcastFn = () => Promise.reject(new Error('the worker died here'));
    await expect(rec.sender.pay(payRequest(fixture))).rejects.toThrow('the worker died here');
    const died = await rowsOf(t.db, fixture);
    expect(died.order.status).toBe('PROCESSING');
    expect(died.attempt.status).toBe('SENT');
    expect(died.transfer?.status).toBe('BROADCAST');
    // The dead fulfill run's lease on the order: its TTL is all that frees it.
    const leaseMs = 1_500;
    const store = new RedisLockStore(r.redis);
    expect(await store.acquire(orderLockKey(fixture.orderId), 'dead-worker', leaseMs)).toBe(true);

    const reads = t.gateway.callCount('getTransactions');
    const held = await rec.service.tick();
    expect(countsOf(held, 'transfers')).toEqual({ busy: 1 });
    expect(t.gateway.callCount('getTransactions')).toBe(reads);
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('BROADCAST');

    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      if ((await r.redis.exists(orderLockKey(fixture.orderId))) === 0) break;
      await sleep(100);
    }
    expect(await r.redis.exists(orderLockKey(fixture.orderId))).toBe(0);
    const freed = await rec.service.tick();
    expect(countsOf(freed, 'transfers')).toEqual({ confirmed: 1 });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONFIRMED');
    expect(rows.attempt.status).toBe('CONFIRMED');
    const { order, ledger, audits } = await r.moneyOf(fixture.orderId);
    expect(order.status).toBe('DELIVERED');
    expect(order.deliveredAt).not.toBeNull();
    expect(ledger.map((entry) => entry.kind)).toEqual(['PURCHASE']);
    // The TON module's own delivery (order PROCESSING): no review resolution row.
    expect(audits).toEqual([]);
    expect(
      await t.db.orderEvent.count({ where: { orderId: fixture.orderId, to: 'DELIVERED' } }),
    ).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    // A third tick finds nothing to do.
    const again = await rec.service.tick();
    expect(countsOf(again, 'transfers')).toEqual({});
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });
});
