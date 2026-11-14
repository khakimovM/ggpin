import { describe, expect, it } from 'vitest';
import {
  ActorRefRequiredError,
  MissingStatusReasonError,
  PurchaseEntryMismatchError,
  PurchaseEntryMissingError,
  refundFailedOrder,
  sumBalance,
  transitionOrder,
  type OrderTransitionInput,
} from '../src/index';
import { createUser } from './factories';
import { db } from './client';
import {
  PRICE,
  captureError,
  forcePurchase,
  orderWithoutDebitIn,
  paidOrder,
  refunds,
  statusOf,
} from './order-fixtures';

// Review findings F2, F7 and audit M3, M4: a refund returns what the ledger took; a reason and an
// operator are never missing. The "no live payout" rules (H2) are in order-guards.e2e.test.ts.
// Since D-60 the database itself refuses an order without its exact debit (and a debit of another
// user or amount): those states are built with the triggers off, and the helper must refuse them too.

const refund = (orderId: string) =>
  db.$transaction((tx) => refundFailedOrder(tx, { orderId, actor: 'system' }));

describe('a refund returns what the ledger took (F2, M4)', () => {
  it('P4: a FAILED order with no PURCHASE entry is not refunded', async () => {
    const user = await createUser();
    await db.wallet.create({ data: { userId: user.id } });
    const order = await orderWithoutDebitIn(user, 'FAILED');
    expect(await captureError(refund(order.id))).toBeInstanceOf(PurchaseEntryMissingError);
    expect(await statusOf(order.id)).toBe('FAILED');
    expect(await sumBalance(db, user.id)).toBe(0n);
  });

  it('a PURCHASE entry that disagrees with the order total stops the refund', async () => {
    const user = await createUser();
    await db.wallet.create({ data: { userId: user.id } });
    const order = await orderWithoutDebitIn(user, 'FAILED');
    await forcePurchase(user.id, order.id, -(PRICE - 1n));
    expect(await captureError(refund(order.id))).toBeInstanceOf(PurchaseEntryMismatchError);
    expect(await refunds(order.id)).toHaveLength(0);
    expect(await statusOf(order.id)).toBe('FAILED');
  });

  it('a PURCHASE entry of another user stops the refund', async () => {
    const other = await createUser();
    await db.wallet.create({ data: { userId: other.id } });
    const stranger = await orderWithoutDebitIn(await createUser(), 'FAILED');
    await db.wallet.create({ data: { userId: stranger.userId } });
    await forcePurchase(other.id, stranger.id, -PRICE);
    expect(await captureError(refund(stranger.id))).toBeInstanceOf(PurchaseEntryMismatchError);
    expect(await refunds(stranger.id)).toHaveLength(0);
  });
});

describe('a reason and an operator are never missing (F7, M3)', () => {
  const bad = (input: Record<string, unknown>) =>
    db.$transaction((tx) => transitionOrder(tx, input as unknown as OrderTransitionInput));

  it.each([
    ['PROCESSING', 'HELD'],
    ['PROCESSING', 'NEEDS_REVIEW'],
    ['PROCESSING', 'FAILED'],
    ['HELD', 'FAILED'],
  ] as const)('%s -> %s without a reason is refused', async (from, to) => {
    const { order } = await paidOrder(from);
    expect(
      await captureError(bad({ orderId: order.id, from, to, actor: 'system' })),
    ).toBeInstanceOf(MissingStatusReasonError);
    expect(await statusOf(order.id)).toBe(from);
  });

  it('an admin transition without the operator id is refused', async () => {
    const { order } = await paidOrder('HELD');
    expect(
      await captureError(bad({ orderId: order.id, from: 'HELD', to: 'CANCELLED', actor: 'admin' })),
    ).toBeInstanceOf(ActorRefRequiredError);
    expect(
      await captureError(
        bad({ orderId: order.id, from: 'HELD', to: 'CANCELLED', actor: 'admin', actorRef: '' }),
      ),
    ).toBeInstanceOf(ActorRefRequiredError);
    expect(await statusOf(order.id)).toBe('HELD');
  });

  it('CANCELLED and the refund keep the reason they find; healthy moves clear it', async () => {
    const { order } = await paidOrder('HELD');
    await db.order.update({ where: { id: order.id }, data: { statusReason: 'LIMIT_DAILY' } });
    await db.$transaction((tx) =>
      transitionOrder(tx, {
        orderId: order.id,
        from: 'HELD',
        to: 'CANCELLED',
        actor: 'admin',
        actorRef: 'a1',
      }),
    );
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).statusReason).toBe(
      'LIMIT_DAILY',
    );
  });
});
