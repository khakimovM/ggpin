import { describe, expect, it } from 'vitest';
import { expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';
import { refunds, walkTo } from './order-fixtures';

// Migration p5_order_purchase_ledger_check, S2 fix round 2: an order keeps its id for life (re-audit
// N1) and is never deleted (review N6). Both guard the D-60 pairing "one order <-> one PURCHASE
// debit under ORDER/<order id>": a re-keyed or deleted order would leave its debit pointing at an
// id a NEW order could take, and that order's refund would then be paid on someone else's debit.

const balanceOf = async (userId: string): Promise<bigint> =>
  (await db.ledgerEntry.aggregate({ where: { userId }, _sum: { amountTiyin: true } }))._sum
    .amountTiyin ?? 0n;

async function fundedBuyer() {
  const user = await createUser();
  await db.ledgerEntry.create({
    data: {
      userId: user.id,
      kind: 'TOPUP',
      amountTiyin: 50_000_000n,
      refType: 'PAYMENT',
      refId: `p-${user.id}`,
    },
  });
  return user;
}

describe('Order.id is immutable', () => {
  it('an UPDATE of the id is refused, by the client and by raw SQL', async () => {
    const order = await createOrder(await createUser());
    await expectGuard(
      db.order.update({ where: { id: order.id }, data: { id: `${order.id}x` } }),
      'is immutable',
    );
    await expectGuard(
      db.$executeRaw`UPDATE "Order" SET "id" = ${`${order.id}y`} WHERE "id" = ${order.id}`,
      'is immutable',
    );
    expect(await db.order.count({ where: { id: order.id } })).toBe(1);
  });

  it('re-audit D11b: one debit can no longer be refunded twice through a re-keyed order', async () => {
    const user = await fundedBuyer();
    const start = await balanceOf(user.id);
    const order = await createOrder(user);
    const debit = order.priceTiyin - order.discountTiyin;
    expect(await balanceOf(user.id)).toBe(start - debit);

    // Step 1 of the attack: move the order away from its debit's refId. Refused.
    await expectGuard(
      db.$executeRaw`UPDATE "Order" SET "id" = ${`${order.id}m`} WHERE "id" = ${order.id}`,
      'is immutable',
    );
    // Step 2: a new, debit-less order under the old id. The id is still taken (primary key).
    await expectPrismaCode(
      createOrder(user, undefined, { id: order.id }, { unguarded: true }),
      'P2002',
    );

    // The one real order refunds once and the balance is back where it started, not above it.
    await walkTo(order.id, 'REFUNDED');
    expect(await refunds(order.id)).toHaveLength(1);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
    expect(await balanceOf(user.id)).toBe(start);
  });
});

describe('Order_no_delete', () => {
  it('a DELETE of an order without children is refused: client delete, deleteMany, raw SQL', async () => {
    const user = await createUser();
    const order = await createOrder(user);
    expect(await db.orderEvent.count({ where: { orderId: order.id } })).toBe(0);
    await expectGuard(db.order.delete({ where: { id: order.id } }), 'is never deleted');
    await expectGuard(db.order.deleteMany({ where: { userId: user.id } }), 'is never deleted');
    await expectGuard(
      db.$executeRaw`DELETE FROM "Order" WHERE "id" = ${order.id}`,
      'is never deleted',
    );
    expect(await db.order.count({ where: { id: order.id } })).toBe(1);
    expect(
      await db.ledgerEntry.count({
        where: { refType: 'ORDER', refId: order.id, kind: 'PURCHASE' },
      }),
    ).toBe(1);
  });

  it('a refunded order is not deleted either', async () => {
    const order = await createOrder(await createUser());
    await walkTo(order.id, 'REFUNDED');
    await expectGuard(db.order.delete({ where: { id: order.id } }), 'is never deleted');
  });

  it('TRUNCATE (the test cleanup) still works: it fires no row trigger', async () => {
    await createOrder(await createUser());
    await db.$executeRawUnsafe('TRUNCATE TABLE "Order" CASCADE');
    expect(await db.order.count()).toBe(0);
  });
});
