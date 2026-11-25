import { transitionOrder } from '@repo/db';
import { coreHoldNote } from '@repo/shared';
import type { PayoutFixture } from '../../../ton/__tests__/ton-e2e.fixtures';
import { countsOf, useReconcileE2e } from './reconcile-e2e.harness';

// Phase 5 S9i acceptance, the HELD_MAX_AGE_MS boundary through the reconciler's whole TICK (the
// step itself is pinned to the millisecond with a handed-in clock in order-reconcile-held.e2e-spec:
// 1 ms before and exactly at it). A tick reads the database clock itself (SA L-6) and an OrderEvent
// cannot be moved by any writer, so the test dates the order's HELD event back with the triggers
// off (the replica role, tests only), relative to the database clock read just before: a hold
// MAX_AGE - 5 s old is untouched by the tick (the tick runs well inside those 5 s), a hold
// MAX_AGE + 1 ms old is refunded by it, once, to its owner, the ledger balance restored.

const r = useReconcileE2e();
const { t } = r;
const MAX_AGE = t.env.HELD_MAX_AGE_MS;

async function dbNowMs(): Promise<number> {
  const [row] = await t.db.$queryRaw<{ ms: string }[]>`
    SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"`;
  return Number(row?.ms);
}

/** A PROCESSING order whose one attempt failed before signing, then HELD (ADAPTER_ERROR). */
async function heldOrder(): Promise<PayoutFixture> {
  const fixture = await r.order();
  await t.db.fulfillmentAttempt.update({
    where: { id: fixture.attemptId },
    data: { status: 'FAILED', error: 'NOT_SENT' },
  });
  await t.db.$transaction((tx) =>
    transitionOrder(tx, {
      orderId: fixture.orderId,
      from: 'PROCESSING',
      to: 'HELD',
      actor: 'system',
      reason: 'ADAPTER_ERROR',
      note: coreHoldNote('ADAPTER_ERROR', 'e2e acceptance'),
    }),
  );
  return fixture;
}

/**
 * The order's HELD event dated `ageMs` before the database clock (triggers off, tests only).
 * `SET LOCAL session_replication_role` needs a superuser (or, on PostgreSQL 15+, a role granted
 * SET on that parameter): the test database role of the dev compose stack is the superuser. A
 * production role must never have it, which is the point of the append-only triggers it skips.
 */
async function heldFor(orderId: string, ageMs: number): Promise<void> {
  const at = new Date((await dbNowMs()) - ageMs);
  await t.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.orderEvent.updateMany({ where: { orderId, to: 'HELD' }, data: { createdAt: at } });
  });
}

async function balanceOf(userId: string): Promise<bigint> {
  const sum = await t.db.ledgerEntry.aggregate({ where: { userId }, _sum: { amountTiyin: true } });
  return sum._sum.amountTiyin ?? 0n;
}

describe('S9i acceptance: HELD_MAX_AGE_MS through the tick', () => {
  it('MAX_AGE - 5 s: untouched; MAX_AGE + 1 ms: one refund to the owner, the balance restored', async () => {
    const rec = await r.boot();
    const young = await heldOrder();
    const old = await heldOrder();
    const before = await balanceOf(old.userId);
    await r.cacheBalance(old.userId);
    await heldFor(young.orderId, MAX_AGE - 5_000);
    await heldFor(old.orderId, MAX_AGE + 1);

    const report = await rec.service.tick();
    // The young order is kept (ADAPTER_ERROR is never released), the old one refunded.
    expect(countsOf(report, 'held')).toEqual({
      refunded: 1,
      refundNoticed: 1,
      'keep:adapterError': 1,
    });
    expect((await r.moneyOf(young.orderId)).order.status).toBe('HELD');
    expect((await r.moneyOf(young.orderId)).ledger.map((e) => e.kind)).toEqual(['PURCHASE']);

    const { order, ledger } = await r.moneyOf(old.orderId);
    expect(order).toMatchObject({ status: 'REFUNDED', statusReason: 'HELD_EXPIRED' });
    const purchase = ledger[0]?.amountTiyin ?? 0n;
    expect(ledger).toEqual([
      { kind: 'PURCHASE', amountTiyin: purchase },
      { kind: 'REFUND', amountTiyin: -purchase },
    ]);
    const refunds = await t.db.ledgerEntry.findMany({
      where: { refType: 'ORDER', refId: old.orderId, kind: 'REFUND' },
      select: { userId: true },
    });
    expect(refunds).toEqual([{ userId: old.userId }]);
    expect(await balanceOf(old.userId)).toBe(before - purchase);
    expect(await r.cached(old.userId)).toBe(false);
    expect(await r.hasJob({ kind: 'ORDER_REFUNDED', refId: old.orderId })).toBe(true);
    expect(
      await r.hasJob({ kind: 'OWNER_ALERT', alert: 'heldExpiredRefunded', refId: old.orderId }),
    ).toBe(true);

    // The next tick: nothing more for either order (the young one is still inside its age).
    const again = await rec.service.tick();
    expect(countsOf(again, 'held')).not.toHaveProperty('refunded');
    expect((await r.moneyOf(old.orderId)).ledger).toHaveLength(2);
    expect((await r.moneyOf(young.orderId)).order.status).toBe('HELD');
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });
});
