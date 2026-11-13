import { IllegalOrderTransitionError } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { NotInTransactionError, StaleOrderStateError, transitionOrder } from '../src/index';
import { db } from './client';
import { addAttempt, captureError, events, paidOrder, statusOf } from './order-fixtures';

// transitionOrder (compare-and-set) and the refund helpers (idempotent refund), on a real
// Postgres. The restrictions of audit H2, the ledger check and the reason rules are in
// order-guards.e2e.test.ts.

describe('transitionOrder', () => {
  it('moves the status, writes the event and sets the reason in one transaction', async () => {
    const { order } = await paidOrder('PROCESSING');
    await db.$transaction((tx) =>
      transitionOrder(tx, {
        orderId: order.id,
        from: 'PROCESSING',
        to: 'HELD',
        actor: 'system',
        reason: 'PRICE_ABOVE_MAX',
        note: 'cost above the ceiling',
      }),
    );
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('HELD');
    expect(row.statusReason).toBe('PRICE_ABOVE_MAX');
    expect(await events(order.id)).toMatchObject([
      { from: 'PROCESSING', to: 'HELD', actor: 'SYSTEM', note: 'cost above the ceiling' },
    ]);
  });

  it('a healthy move clears the previous reason', async () => {
    const { order } = await paidOrder('HELD');
    await db.order.update({ where: { id: order.id }, data: { statusReason: 'LOW_BALANCE' } });
    await db.$transaction((tx) =>
      transitionOrder(tx, { orderId: order.id, from: 'HELD', to: 'QUEUED', actor: 'system' }),
    );
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).statusReason).toBeNull();
  });

  it('entering DELIVERED stamps deliveredAt (the CHECK requires it)', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    // The attempt is confirmed in the same transaction as the delivery (D-59 N1).
    await db.$transaction(async (tx) => {
      await tx.fulfillmentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'CONFIRMED' },
      });
      await transitionOrder(tx, {
        orderId: order.id,
        from: 'PROCESSING',
        to: 'DELIVERED',
        actor: 'system',
      });
    });
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).deliveredAt,
    ).not.toBeNull();
  });

  it('names the actor in the event: SYSTEM and ADMIN:<id>', async () => {
    const a = await paidOrder('QUEUED');
    await db.$transaction((tx) =>
      transitionOrder(tx, {
        orderId: a.order.id,
        from: 'QUEUED',
        to: 'PROCESSING',
        actor: 'system',
      }),
    );
    const b = await paidOrder('HELD');
    await db.$transaction((tx) =>
      transitionOrder(tx, {
        orderId: b.order.id,
        from: 'HELD',
        to: 'CANCELLED',
        actor: 'admin',
        actorRef: 'adm1',
      }),
    );
    expect((await events(a.order.id)).map((e) => e.actor)).toEqual(['SYSTEM']);
    expect((await events(b.order.id)).map((e) => e.actor)).toEqual(['ADMIN:adm1']);
  });

  it('refuses a move the state machine does not allow, and writes nothing', async () => {
    const { order } = await paidOrder('PAID');
    const error = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, { orderId: order.id, from: 'PAID', to: 'DELIVERED', actor: 'system' }),
      ),
    );
    expect(error).toBeInstanceOf(IllegalOrderTransitionError);
    expect(await statusOf(order.id)).toBe('PAID');
    expect(await events(order.id)).toHaveLength(0);
  });

  it('refuses an actor the table does not allow', async () => {
    const { order } = await paidOrder('HELD');
    const error = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, {
          orderId: order.id,
          from: 'HELD',
          to: 'CANCELLED',
          actor: 'system',
        }),
      ),
    );
    expect(error).toBeInstanceOf(IllegalOrderTransitionError);
    expect(await statusOf(order.id)).toBe('HELD');
  });

  it('a stale read is refused: nothing is written when the order already moved', async () => {
    const { order } = await paidOrder('QUEUED');
    const error = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, { orderId: order.id, from: 'PAID', to: 'QUEUED', actor: 'system' }),
      ),
    );
    expect(error).toBeInstanceOf(StaleOrderStateError);
    expect(await events(order.id)).toHaveLength(0);
    const missing = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, { orderId: 'ghost', from: 'PAID', to: 'QUEUED', actor: 'system' }),
      ),
    );
    expect(missing).toBeInstanceOf(StaleOrderStateError);
  });

  it('the status and its event are atomic: a failure after the move rolls both back', async () => {
    const { order } = await paidOrder('PAID');
    await captureError(
      db.$transaction(async (tx) => {
        await transitionOrder(tx, {
          orderId: order.id,
          from: 'PAID',
          to: 'QUEUED',
          actor: 'system',
        });
        throw new Error('boom');
      }),
    );
    expect(await statusOf(order.id)).toBe('PAID');
    expect(await events(order.id)).toHaveLength(0);
  });

  it('the race: three workers move the same PAID order, exactly one wins', async () => {
    const { order } = await paidOrder('PAID');
    const attempt = () =>
      db.$transaction((tx) =>
        transitionOrder(tx, { orderId: order.id, from: 'PAID', to: 'QUEUED', actor: 'system' }),
      );
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StaleOrderStateError);
    }
    expect(await statusOf(order.id)).toBe('QUEUED');
    expect(await events(order.id)).toHaveLength(1);
  });

  it('needs a transaction: the root client is refused', async () => {
    const { order } = await paidOrder('PAID');
    const error = await captureError(
      transitionOrder(db, { orderId: order.id, from: 'PAID', to: 'QUEUED', actor: 'system' }),
    );
    expect(error).toBeInstanceOf(NotInTransactionError);
    expect(await statusOf(order.id)).toBe('PAID');
  });
});
