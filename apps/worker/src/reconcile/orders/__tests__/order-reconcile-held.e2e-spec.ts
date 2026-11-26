import type { Tx } from '@repo/db';
import { HELD_AUTO_RELEASE_MAX, REVIEW_NOTICE_RESEND_WINDOW_MS } from '@repo/shared';
import { release } from '../../../fulfillment/__tests__/attempt-release.fixtures';
import {
  ledgerOf,
  orderRow,
  timelineOf,
} from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { episodeRef } from '../guard-ref';
import { HeldWriter } from '../held-writes';
import { useHeldE2e } from './held-sweep.e2e-kit';

// Phase 5 S9e, the money path (D-64 (4), Q-2, rules/70 money set): a HELD order refunded at
// HELD_MAX_AGE_MS since its latest hold (`>=`), once, to its owner only, in one transaction with
// its effects after the commit; never with a payout that may be live, never without a matching
// PURCHASE debit (NO_PURCHASE: the owner's alert again, same id). The steps get the database
// clock as `nowMs` (stored times cannot be moved): every boundary is exact to the millisecond.

const h = useHeldE2e();
const { t } = h;
const MAX_AGE = t.env.HELD_MAX_AGE_MS;
const refunded = (refId: string) => ({ kind: 'ORDER_REFUNDED', refId }) as const;

/** A HELD order (ADAPTER_ERROR: never released, so only the age decides) and its hold time. */
async function heldOrder(reason: 'ADAPTER_ERROR' | 'NO_ADAPTER' = 'ADAPTER_ERROR') {
  const fixture = await h.order();
  await h.holdAs(fixture.orderId, reason);
  return { ...fixture, heldAt: await h.heldAtMs(fixture.orderId) };
}

describe('S9e: HELD_MAX_AGE_MS refund', () => {
  it('1 ms before: untouched; exactly at it: FAILED -> REFUNDED, REFUND = -PURCHASE, effects', async () => {
    const rc = await h.boot();
    const order = await heldOrder();
    const bystander = await heldOrder();
    await h.cacheBalance(order.userId);

    const early = await rc.held.run({ nowMs: order.heldAt + MAX_AGE - 1 });
    expect(early.ids).not.toContain(order.orderId);
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');

    const report = await rc.held.run({ nowMs: order.heldAt + MAX_AGE });
    expect(report.ids).toContain(order.orderId);
    expect(await orderRow(t.db, order.orderId)).toMatchObject({
      status: 'REFUNDED',
      statusReason: 'HELD_EXPIRED',
    });
    expect((await timelineOf(t.db, order.orderId)).slice(-3)).toEqual([
      'HELD',
      'FAILED',
      'REFUNDED',
    ]);
    const ledger = await t.db.ledgerEntry.findMany({
      where: { refType: 'ORDER', refId: order.orderId },
      select: { kind: true, amountTiyin: true, userId: true },
    });
    const purchase = ledger.find((l) => l.kind === 'PURCHASE');
    expect(ledger.filter((l) => l.kind === 'REFUND')).toEqual([
      { kind: 'REFUND', amountTiyin: -(purchase?.amountTiyin ?? 0n), userId: order.userId },
    ]);
    // Ownership: the refund went to this order's owner only; the other HELD order is untouched.
    expect((await ledgerOf(t.db, bystander.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    expect((await orderRow(t.db, bystander.orderId)).status).toBe('HELD');
    const failed = await t.db.orderEvent.findFirstOrThrow({
      where: { orderId: order.orderId, to: 'FAILED' },
    });
    expect(failed.actor).toBe('SYSTEM');
    // After the commit: the cache, the customer, the owner (stable ids).
    expect(await h.cached(order.userId)).toBe(false);
    expect(await t.hasJob(refunded(order.orderId))).toBe(true);
    expect(await h.hasAlert('heldExpiredRefunded', order.orderId)).toBe(true);
  });

  it('two ticks, then two reconcilers at once (the lease granted to both): one REFUND each', async () => {
    const first = await heldOrder('NO_ADAPTER');
    const rc = await h.boot();
    await rc.held.run({ nowMs: first.heldAt + MAX_AGE });
    const again = await rc.held.run({ nowMs: first.heldAt + MAX_AGE + 1 });
    expect(again.ids).not.toContain(first.orderId);
    expect((await ledgerOf(t.db, first.orderId)).map((l) => l.kind).sort()).toEqual([
      'PURCHASE',
      'REFUND',
    ]);

    const second = await heldOrder('NO_ADAPTER');
    const [a, b] = [await h.boot({ grantingLock: true }), await h.boot({ grantingLock: true })];
    const nowMs = second.heldAt + MAX_AGE;
    const reports = await Promise.all([a.held.run({ nowMs }), b.held.run({ nowMs })]);
    const counts = reports.map((r) => r.counts['refunded'] ?? 0);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
    expect((await ledgerOf(t.db, second.orderId)).filter((l) => l.kind === 'REFUND')).toHaveLength(
      1,
    );
    expect(
      await t.db.orderEvent.count({ where: { orderId: second.orderId, to: 'REFUNDED' } }),
    ).toBe(1);
  });

  it('the owner order:retry and the refund at once: QUEUED or REFUNDED, never both', async () => {
    const rc = await h.boot();
    const outcomes = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const order = await heldOrder();
      const [, released] = await Promise.all([
        rc.held.run({ nowMs: order.heldAt + MAX_AGE }),
        release(t.db, order.orderId, { kind: 'CLI' }),
      ]);
      const status = (await orderRow(t.db, order.orderId)).status;
      const refunds = (await ledgerOf(t.db, order.orderId)).filter((l) => l.kind === 'REFUND');
      if (released) {
        expect(status).toBe('QUEUED');
        expect(refunds).toHaveLength(0);
      } else {
        expect(status).toBe('REFUNDED');
        expect(refunds).toHaveLength(1);
      }
      outcomes.add(status);
    }
    expect([...outcomes].every((s) => s === 'QUEUED' || s === 'REFUNDED')).toBe(true);
  });

  it('a failure inside the refund transaction writes nothing; the next tick refunds', async () => {
    const order = await heldOrder();
    const broken = await h.boot({ writer: (prisma) => new HeldWriter(failingCount(prisma)) });
    const report = await broken.held.run({ nowMs: order.heldAt + MAX_AGE });
    expect(report.counts['failed']).toBe(1);
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
    expect((await ledgerOf(t.db, order.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    expect(await t.db.orderEvent.count({ where: { orderId: order.orderId, to: 'FAILED' } })).toBe(
      0,
    );
    expect(await t.hasJob(refunded(order.orderId))).toBe(false);

    const rc = await h.boot();
    await rc.held.run({ nowMs: order.heldAt + MAX_AGE });
    expect((await orderRow(t.db, order.orderId)).status).toBe('REFUNDED');
  });

  it('a live attempt under a HELD order (DB guards off): no refund, reconcileGuardRefused', async () => {
    const order = await heldOrder();
    await h.withTriggersOff((tx) =>
      tx.fulfillmentAttempt.create({
        data: {
          orderId: order.orderId,
          attemptNo: 1,
          adapter: 'FRAGMENT',
          status: 'SENDING',
          request: {},
        },
      }),
    );
    const rc = await h.boot();
    const nowMs = order.heldAt + MAX_AGE;
    const report = await rc.held.run({ nowMs });
    expect(report.counts).toMatchObject({ guardRefused: 1, 'guard:livePayout': 1 });
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
    expect((await ledgerOf(t.db, order.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    const ref = episodeRef(order.orderId, 'held', nowMs);
    expect(ref === null ? false : await h.hasAlert('reconcileGuardRefused', ref)).toBe(true);
  });

  it('NO_PURCHASE: never refunded or released, orderNoPurchase again under the same id', async () => {
    const order = await heldOrder('NO_ADAPTER');
    await h.withTriggersOff((tx) =>
      tx.ledgerEntry.updateMany({
        where: { refType: 'ORDER', refId: order.orderId, kind: 'PURCHASE' },
        data: { amountTiyin: -1n },
      }),
    );
    const rc = await h.boot();
    for (const nowMs of [order.heldAt + 60_000, order.heldAt + 10 * MAX_AGE]) {
      await h.dropAlert('orderNoPurchase', order.orderId);
      const report = await rc.held.run({ nowMs });
      expect(report.counts['noPurchase']).toBe(1);
      expect(await h.hasAlert('orderNoPurchase', order.orderId)).toBe(true);
    }
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
    expect((await ledgerOf(t.db, order.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    expect(await h.releasesOf(order.orderId)).toBe(0);
  });

  it('lost effects come back inside the window (same ids), never after it', async () => {
    const order = await heldOrder();
    const rc = await h.boot();
    await rc.held.run({ nowMs: order.heldAt + MAX_AGE });
    await t.dropJob(refunded(order.orderId));
    await h.dropAlert('heldExpiredRefunded', order.orderId);
    const now = await h.dbNowMs();
    const late = await rc.held.run({ nowMs: now + REVIEW_NOTICE_RESEND_WINDOW_MS + 60_000 });
    expect(late.counts['refundNoticed']).toBeUndefined();
    expect(await t.hasJob(refunded(order.orderId))).toBe(false);
    await rc.held.run({ nowMs: now + 60_000 });
    expect(await t.hasJob(refunded(order.orderId))).toBe(true);
    expect(await h.hasAlert('heldExpiredRefunded', order.orderId)).toBe(true);
    expect((await ledgerOf(t.db, order.orderId)).filter((l) => l.kind === 'REFUND')).toHaveLength(
      1,
    );
  });

  it('the release cap does not stop the refund (a capped order is refunded at the age)', async () => {
    expect(HELD_AUTO_RELEASE_MAX).toBe(3);
    const order = await heldOrder('NO_ADAPTER');
    await t.db.productRoute.updateMany({
      where: { productId: order.productId },
      data: { isEnabled: false },
    });
    const rc = await h.boot();
    const kept = await rc.held.run({ nowMs: order.heldAt + 60_000 });
    expect(kept.counts['keep:noRoute']).toBe(1);
    await rc.held.run({ nowMs: order.heldAt + MAX_AGE });
    expect((await orderRow(t.db, order.orderId)).status).toBe('REFUNDED');
  });
});

/**
 * The Prisma client of a writer whose transaction throws after the refund helper wrote (the
 * HELD-event count of the hold fence fails): everything in it must roll back.
 */
function failingCount(prisma: PrismaService): Pick<PrismaService, 'client'> {
  const client = new Proxy(prisma.client, {
    get(target, prop): unknown {
      if (prop !== '$transaction') return own(target, prop);
      return (fn: (tx: Tx) => Promise<unknown>) =>
        target.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(inner, key): unknown {
                if (key !== 'orderEvent') return own(inner, key);
                return new Proxy(inner.orderEvent, {
                  get(events, name): unknown {
                    if (name === 'count') return () => Promise.reject(new Error('injected'));
                    return own(events, name);
                  },
                });
              },
            }),
          ),
        );
    },
  });
  return { client };
}

/** A property of the real object, a method bound to it (Prisma's methods need their own `this`). */
function own(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}
