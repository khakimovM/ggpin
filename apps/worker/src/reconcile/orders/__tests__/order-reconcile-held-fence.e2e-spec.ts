import { failAndRefundOrder } from '@repo/db';
import { release } from '../../../fulfillment/__tests__/attempt-release.fixtures';
import { ledgerOf, orderRow } from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { episodeRef } from '../guard-ref';
import { HeldWriter, HoldChangedError } from '../held-writes';
import { useHeldE2e } from './held-sweep.e2e-kit';

// Phase 5 S9e fix round, on the real database: the hold fence (a decision made on one hold is
// never written on another: CR F2, SA L-3(a)), a PURCHASE of another user (SA L-3(b)), a HELD
// order without a HELD event (CR F4), the refund effects resent for the reconciler's own refunds
// only (CR F5) and the clock read again when the step starts (SA L-6). Nothing here moves money
// that should not move: every test reads the ledger back.

const h = useHeldE2e();
const { t } = h;
const MAX_AGE = t.env.HELD_MAX_AGE_MS;
const HOUR = 3_600_000;

async function heldOrder(reason: 'ADAPTER_ERROR' | 'NO_ADAPTER' = 'ADAPTER_ERROR') {
  const fixture = await h.order();
  await h.holdAs(fixture.orderId, reason);
  return { ...fixture, heldAt: await h.heldAtMs(fixture.orderId) };
}

async function untouched(orderId: string): Promise<void> {
  expect((await orderRow(t.db, orderId)).status).toBe('HELD');
  expect((await ledgerOf(t.db, orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
  expect(await t.db.orderEvent.count({ where: { orderId, to: 'FAILED' } })).toBe(0);
}

/** A writer whose refund first lets an operator release the order and the run hold it again. */
class RaceWriter extends HeldWriter {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  override async refund(orderId: string, heldEvents: number) {
    expect(await release(t.db, orderId, { kind: 'CLI' })).toBe(true);
    await h.holdAs(orderId, 'ADAPTER_ERROR');
    return super.refund(orderId, heldEvents);
  }
}

describe('S9e fix: the hold fence', () => {
  it('refund and release on a hold count that is not the order’s: HoldChangedError, nothing written', async () => {
    const order = await heldOrder('NO_ADAPTER');
    const writer = (await h.boot()).moduleRef.get(HeldWriter);
    const count = await h.heldEvents(order.orderId);
    await expect(writer.refund(order.orderId, count - 1)).rejects.toBeInstanceOf(HoldChangedError);
    await untouched(order.orderId);
    await expect(writer.release(order.orderId, 'NO_ADAPTER', count + 1)).rejects.toBeInstanceOf(
      HoldChangedError,
    );
    await untouched(order.orderId);
    expect(await h.releasesOf(order.orderId)).toBe(0);
    expect(await t.db.orderEvent.count({ where: { orderId: order.orderId, to: 'QUEUED' } })).toBe(
      1, // PAID -> QUEUED of the fixture only
    );
  });

  it('released and held again between the decision and the write: stale, no refund', async () => {
    const order = await heldOrder();
    const rc = await h.boot({ writer: (prisma) => new RaceWriter(prisma) });
    const report = await rc.held.run({ nowMs: order.heldAt + MAX_AGE });
    expect(report.counts).toMatchObject({ stale: 1 });
    expect(report.counts['refunded']).toBeUndefined();
    await untouched(order.orderId);
    expect(await h.heldEvents(order.orderId)).toBe(2);
    expect(await t.hasJob({ kind: 'ORDER_REFUNDED', refId: order.orderId })).toBe(false);
  });
});

describe('S9e fix: orders the step must not touch', () => {
  it('a PURCHASE written for another user: NO_PURCHASE, never refunded (SA L-3(b))', async () => {
    const order = await heldOrder();
    const other = await h.order();
    await h.withTriggersOff((tx) =>
      tx.ledgerEntry.updateMany({
        where: { refType: 'ORDER', refId: order.orderId, kind: 'PURCHASE' },
        data: { userId: other.userId },
      }),
    );
    const rc = await h.boot();
    await h.dropAlert('orderNoPurchase', order.orderId);
    const report = await rc.held.run({ nowMs: order.heldAt + 2 * MAX_AGE });
    expect(report.counts).toMatchObject({ noPurchase: 1 });
    expect(await h.hasAlert('orderNoPurchase', order.orderId)).toBe(true);
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
    const refunds = await t.db.ledgerEntry.count({
      where: { refType: 'ORDER', refId: order.orderId, kind: 'REFUND' },
    });
    expect(refunds).toBe(0);
  });

  it('the release path too: NO_ADAPTER, a young hold, another user’s PURCHASE -> noPurchase, never released', async () => {
    const order = await heldOrder('NO_ADAPTER');
    const other = await h.order();
    await h.withTriggersOff((tx) =>
      tx.ledgerEntry.updateMany({
        where: { refType: 'ORDER', refId: order.orderId, kind: 'PURCHASE' },
        data: { userId: other.userId },
      }),
    );
    const rc = await h.boot();
    const report = await rc.held.run({ nowMs: order.heldAt + 60_000 });
    expect(report.counts).toMatchObject({ noPurchase: 1 });
    expect(report.counts['released']).toBeUndefined();
    expect(await h.releasesOf(order.orderId)).toBe(0);
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
  });

  it('HELD without a HELD event: noHeldEvent + reconcileGuardRefused, never refunded (CR F4)', async () => {
    const order = await heldOrder('NO_ADAPTER');
    await h.withTriggersOff((tx) =>
      tx.orderEvent.deleteMany({ where: { orderId: order.orderId, to: 'HELD' } }),
    );
    const rc = await h.boot();
    const nowMs = order.heldAt + 10 * MAX_AGE;
    const report = await rc.held.run({ nowMs });
    expect(report.counts).toMatchObject({ noHeldEvent: 1 });
    expect(report.counts['moved']).toBeUndefined();
    const ref = episodeRef(order.orderId, 'held', nowMs);
    expect(ref === null ? false : await h.hasAlert('reconcileGuardRefused', ref)).toBe(true);
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
    expect((await ledgerOf(t.db, order.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
  });
});

describe('S9e fix: resent effects and the clock', () => {
  it('an operator refund with reason HELD_EXPIRED gets no heldExpiredRefunded (CR F5)', async () => {
    const order = await heldOrder();
    await t.db.$transaction((tx) =>
      failAndRefundOrder(tx, {
        orderId: order.orderId,
        from: 'HELD',
        reason: 'HELD_EXPIRED',
        actor: 'admin',
        actorRef: 'owner-e2e',
      }),
    );
    expect((await orderRow(t.db, order.orderId)).status).toBe('REFUNDED');
    const rc = await h.boot();
    const report = await rc.held.run({ nowMs: (await h.dbNowMs()) + 60_000 });
    expect(report.counts['refundNoticed']).toBeUndefined();
    expect(await h.hasAlert('heldExpiredRefunded', order.orderId)).toBe(false);
    expect(await t.hasJob({ kind: 'ORDER_REFUNDED', refId: order.orderId })).toBe(false);
  });

  it('a stale tick clock is replaced by the database clock (SA L-6)', async () => {
    const order = await heldOrder();
    // The hold happened 7 hours ago (database clock); the tick's clock is 2 hours old.
    const dbNow = await h.dbNowMs();
    await h.withTriggersOff((tx) =>
      tx.orderEvent.updateMany({
        where: { orderId: order.orderId, to: 'HELD' },
        data: { createdAt: new Date(dbNow - 7 * HOUR) },
      }),
    );
    const rc = await h.boot();
    const report = await rc.held.run({ nowMs: dbNow - 2 * HOUR });
    expect(report.counts).toMatchObject({ refunded: 1 });
    expect((await orderRow(t.db, order.orderId)).status).toBe('REFUNDED');
  });
});
