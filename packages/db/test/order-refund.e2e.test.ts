import { describe, expect, it } from 'vitest';
import {
  NotInTransactionError,
  OrderNotFoundError,
  StaleOrderStateError,
  failAndRefundOrder,
  refundFailedOrder,
  sumBalance,
} from '../src/index';
import { db } from './client';
import { PRICE, captureError, events, paidOrder, refunds, statusOf } from './order-fixtures';

// The refund helpers (idempotent, atomic with the failure), on a real Postgres. The CAS of
// transitionOrder is in order-helpers.e2e.test.ts; the restrictions of audit H2 are in
// order-guards.e2e.test.ts.

describe('refundFailedOrder', () => {
  const refund = (orderId: string) =>
    db.$transaction((tx) => refundFailedOrder(tx, { orderId, actor: 'system' }));

  it('FAILED -> REFUNDED with a REFUND entry for exactly what the purchase took', async () => {
    const { user, order } = await paidOrder('FAILED');
    expect(await sumBalance(db, user.id)).toBe(-PRICE);
    const result = await refund(order.id);
    expect(result).toMatchObject({ outcome: 'REFUNDED', userId: user.id, amountTiyin: PRICE });
    expect(await sumBalance(db, user.id)).toBe(0n);
    expect(await statusOf(order.id)).toBe('REFUNDED');
    expect(await refunds(order.id)).toHaveLength(1);
    expect(await events(order.id)).toMatchObject([{ from: 'FAILED', to: 'REFUNDED' }]);
  });

  it('refunds price minus discount, the amount the PURCHASE entry took', async () => {
    const { user, order } = await paidOrder('FAILED', 1_200_000n);
    const result = await refund(order.id);
    expect(result).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE - 1_200_000n });
    expect(await sumBalance(db, user.id)).toBe(0n);
  });

  it('is idempotent: the second call answers ALREADY_REFUNDED and writes nothing', async () => {
    const { user, order } = await paidOrder('FAILED');
    await refund(order.id);
    expect(await refund(order.id)).toEqual({ outcome: 'ALREADY_REFUNDED', userId: user.id });
    expect(await refunds(order.id)).toHaveLength(1);
    expect(await events(order.id)).toHaveLength(1);
    expect(await sumBalance(db, user.id)).toBe(0n);
  });

  it('concurrent refunds pay once: one REFUNDED, the others ALREADY_REFUNDED', async () => {
    const { user, order } = await paidOrder('FAILED');
    const results = await Promise.all([refund(order.id), refund(order.id), refund(order.id)]);
    expect(results.filter((r) => r.outcome === 'REFUNDED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'ALREADY_REFUNDED')).toHaveLength(2);
    expect(await refunds(order.id)).toHaveLength(1);
    expect(await sumBalance(db, user.id)).toBe(0n);
  });

  it('refuses an order that is not FAILED, and writes nothing', async () => {
    for (const status of ['PAID', 'PROCESSING', 'HELD', 'NEEDS_REVIEW', 'DELIVERED'] as const) {
      const { user, order } = await paidOrder(status);
      expect(await captureError(refund(order.id))).toBeInstanceOf(StaleOrderStateError);
      expect(await refunds(order.id)).toHaveLength(0);
      expect(await sumBalance(db, user.id)).toBe(-PRICE);
    }
  });

  it('an unknown order is OrderNotFoundError', async () => {
    expect(await captureError(refund('ghost'))).toBeInstanceOf(OrderNotFoundError);
  });

  it('the failure and its refund are one unit: a later error rolls both back', async () => {
    const { user, order } = await paidOrder('PROCESSING');
    await captureError(
      db.$transaction(async (tx) => {
        await failAndRefundOrder(tx, {
          orderId: order.id,
          from: 'PROCESSING',
          reason: 'RECIPIENT_GONE',
          actor: 'system',
        });
        throw new Error('boom');
      }),
    );
    expect(await statusOf(order.id)).toBe('PROCESSING');
    expect(await refunds(order.id)).toHaveLength(0);
    expect(await sumBalance(db, user.id)).toBe(-PRICE);
  });

  it('failAndRefundOrder leaves two events, one entry, and keeps the reason after the refund', async () => {
    const { user, order } = await paidOrder('PROCESSING');
    const result = await db.$transaction((tx) =>
      failAndRefundOrder(tx, {
        orderId: order.id,
        from: 'PROCESSING',
        reason: 'RECIPIENT_GONE',
        actor: 'system',
      }),
    );
    expect(result.outcome).toBe('REFUNDED');
    expect((await events(order.id)).map((e) => `${e.from}>${e.to}`)).toEqual([
      'PROCESSING>FAILED',
      'FAILED>REFUNDED',
    ]);
    expect(await sumBalance(db, user.id)).toBe(0n);
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('REFUNDED');
    expect(row.statusReason).toBe('RECIPIENT_GONE');
  });

  it('a HELD order that ran out of time fails and refunds with its reason', async () => {
    const { order } = await paidOrder('HELD');
    await db.$transaction((tx) =>
      failAndRefundOrder(tx, {
        orderId: order.id,
        from: 'HELD',
        reason: 'HELD_EXPIRED',
        actor: 'system',
      }),
    );
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).statusReason).toBe(
      'HELD_EXPIRED',
    );
  });

  it('failAndRefundOrder is idempotent too: a second call finds the order already REFUNDED', async () => {
    const { order } = await paidOrder('PROCESSING');
    const run = () =>
      db.$transaction((tx) =>
        failAndRefundOrder(tx, {
          orderId: order.id,
          from: 'PROCESSING',
          reason: 'RECIPIENT_GONE',
          actor: 'system',
        }),
      );
    await run();
    expect(await captureError(run())).toBeInstanceOf(StaleOrderStateError);
    expect(await refunds(order.id)).toHaveLength(1);
  });

  it('needs a transaction: the root client is refused', async () => {
    const { order } = await paidOrder('FAILED');
    const error = await captureError(refundFailedOrder(db, { orderId: order.id, actor: 'system' }));
    expect(error).toBeInstanceOf(NotInTransactionError);
  });
});
