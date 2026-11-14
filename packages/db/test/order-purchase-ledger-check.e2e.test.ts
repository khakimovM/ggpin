import { describe, expect, it } from 'vitest';
import type { Prisma, Quote, Tx, User } from '../src/index';
import { expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createDiscountCode, createOrder, createQuote, createUser } from './factories';
import { PRICE } from './order-fixtures';

// Owner decision D-60 (1), S2 audit M1 (migration p5_order_purchase_ledger_check): an order and
// its PURCHASE debit exist only together, checked at COMMIT. Order side: a new order has exactly one
// LedgerEntry(PURCHASE, ORDER/<id>) of its own user for -(price - discount). Ledger side: a new
// PURCHASE is that debit (refType ORDER, an order of the same user, the order's amount).

const ORDER_SIDE = 'without its PURCHASE ledger entry';
const LEDGER_SIDE = 'is a PURCHASE that is not the debit of an order of its own user';
const DISCOUNT = 1_200_000n;

// A refusal at the COMMIT of an interactive transaction carries the guard's message, not the
// SQLSTATE (as in order-deferred-guards.e2e.test.ts); a single autocommit statement carries both.
const expectRefusedAtCommit = (promise: Promise<unknown>, fragment: string) =>
  expect(promise).rejects.toThrow(fragment);

let seq = 0;

/** The Order INSERT data the guards of migration 10 accept for `quote` (PAID, its fixed columns). */
function orderData(quote: Quote, discountTiyin = 0n): Prisma.OrderUncheckedCreateInput {
  seq += 1;
  return {
    userId: quote.userId,
    quoteId: quote.id,
    productId: quote.productId,
    quantity: quote.quantity,
    recipient: { username: 'someone' },
    priceTiyin: quote.priceTiyin,
    discountTiyin,
    costCurrency: quote.costCurrency,
    fxRateId: quote.fxRateId,
    costMinor: quote.costMinor,
    maxCostMinor: quote.maxCostMinor,
    status: 'PAID',
    idempotencyKey: `purchase-check-${String(seq)}`,
    requestHash: 'hash-a',
  };
}

function purchase(tx: Tx, userId: string, refId: string, amountTiyin: bigint, refType = 'ORDER') {
  return tx.ledgerEntry.create({
    data: { userId, kind: 'PURCHASE', amountTiyin, refType, refId },
  });
}

async function buyer(): Promise<{ user: User; quote: Quote }> {
  const user = await createUser();
  return { user, quote: await createQuote(user.id) };
}

const ordersOf = (quoteId: string) => db.order.count({ where: { quoteId } });
const purchasesOf = (userId: string) =>
  db.ledgerEntry.count({ where: { userId, kind: 'PURCHASE' } });

describe('a new order needs its PURCHASE debit at COMMIT (D-60)', () => {
  it('an order without a debit cannot commit, and leaves nothing', async () => {
    const { user, quote } = await buyer();
    await expectGuard(db.order.create({ data: orderData(quote) }), ORDER_SIDE);
    expect(await ordersOf(quote.id)).toBe(0);
    expect(await purchasesOf(user.id)).toBe(0);
  });

  it.each([
    ['1 tiyin', (): bigint => -1n],
    ['one tiyin short', (price: bigint) => -(price - 1n)],
    ['one tiyin too much', (price: bigint) => -(price + 1n)],
  ])('a debit of %s instead of the price cannot commit', async (_case, amount) => {
    const { user, quote } = await buyer();
    await expectRefusedAtCommit(
      db.$transaction(async (tx) => {
        const order = await tx.order.create({ data: orderData(quote) });
        await purchase(tx, user.id, order.id, amount(order.priceTiyin));
      }),
      ORDER_SIDE,
    );
    expect(await ordersOf(quote.id)).toBe(0);
    expect(await purchasesOf(user.id)).toBe(0);
  });

  it('a debit of another user (the right amount) cannot commit', async () => {
    const { user, quote } = await buyer();
    const other = await createUser();
    await expectRefusedAtCommit(
      db.$transaction(async (tx) => {
        const order = await tx.order.create({ data: orderData(quote) });
        await purchase(tx, other.id, order.id, -order.priceTiyin);
      }),
      ORDER_SIDE,
    );
    expect(await ordersOf(quote.id)).toBe(0);
    expect((await purchasesOf(user.id)) + (await purchasesOf(other.id))).toBe(0);
  });

  it('a discounted order: the full price is refused, price - discount commits', async () => {
    const user = await createUser();
    const code = await createDiscountCode(user.id);
    const refused = await createQuote(user.id, { discountCodeId: code.id });
    await expectRefusedAtCommit(
      db.$transaction(async (tx) => {
        const order = await tx.order.create({ data: orderData(refused, DISCOUNT) });
        await purchase(tx, user.id, order.id, -order.priceTiyin);
      }),
      ORDER_SIDE,
    );
    expect(await ordersOf(refused.id)).toBe(0);
    const quote = await createQuote(user.id, { discountCodeId: code.id });
    const id = await db.$transaction(async (tx) => {
      const order = await tx.order.create({ data: orderData(quote, DISCOUNT) });
      await purchase(tx, user.id, order.id, -(PRICE - DISCOUNT));
      return order.id;
    });
    const entries = await db.ledgerEntry.findMany({ where: { refId: id, kind: 'PURCHASE' } });
    expect(entries.map((e) => e.amountTiyin)).toEqual([-(PRICE - DISCOUNT)]);
  });

  it('two debits of one order: the second is refused at once (unique), nothing commits', async () => {
    const { user, quote } = await buyer();
    await expectPrismaCode(
      db.$transaction(async (tx) => {
        const order = await tx.order.create({ data: orderData(quote) });
        await purchase(tx, user.id, order.id, -order.priceTiyin);
        await purchase(tx, user.id, order.id, -order.priceTiyin);
      }),
      'P2002',
    );
    expect(await ordersOf(quote.id)).toBe(0);
    expect(await purchasesOf(user.id)).toBe(0);
  });

  it('the order and its exact debit commit, in either order inside the transaction', async () => {
    const first = await buyer();
    await db.$transaction(async (tx) => {
      const order = await tx.order.create({ data: orderData(first.quote) });
      await purchase(tx, first.user.id, order.id, -order.priceTiyin);
    });
    const second = await buyer();
    const id = 'purchase-check-debit-first';
    await db.$transaction(async (tx) => {
      await purchase(tx, second.user.id, id, -PRICE);
      await tx.order.create({ data: { ...orderData(second.quote), id } });
    });
    expect(await ordersOf(first.quote.id)).toBe(1);
    expect(await ordersOf(second.quote.id)).toBe(1);
    expect(await purchasesOf(first.user.id)).toBe(1);
    expect(await purchasesOf(second.user.id)).toBe(1);
  });

  it('the test factory writes the pair the same way', async () => {
    const order = await createOrder(await createUser());
    const entries = await db.ledgerEntry.findMany({ where: { refId: order.id } });
    expect(entries.map((e) => [e.kind, e.userId, e.amountTiyin])).toEqual([
      ['PURCHASE', order.userId, -PRICE],
    ]);
  });
});

describe('a new PURCHASE entry is the debit of an order of its own user (D-60)', () => {
  // An order written with the triggers off: it has no debit yet, so a later PURCHASE for it meets
  // only the ledger side (the unique index does not step in first).
  const bareOrder = async () => {
    const user = await createUser();
    const order = await createOrder(user, undefined, {}, { unguarded: true });
    return { user, order };
  };

  it('a PURCHASE without any order cannot commit', async () => {
    const user = await createUser();
    await expectRefusedAtCommit(
      db.$transaction((tx) => purchase(tx, user.id, 'no-such-order', -PRICE)),
      LEDGER_SIDE,
    );
    expect(await purchasesOf(user.id)).toBe(0);
  });

  it('a PURCHASE under another refType cannot commit', async () => {
    const { user, order } = await bareOrder();
    for (const refType of ['PAYMENT', 'ADMIN_ACTION', 'TEST']) {
      await expectRefusedAtCommit(
        db.$transaction((tx) => purchase(tx, user.id, order.id, -PRICE, refType)),
        LEDGER_SIDE,
      );
    }
    expect(await purchasesOf(user.id)).toBe(0);
  });

  it("a PURCHASE for another user's order cannot commit", async () => {
    const { order } = await bareOrder();
    const stranger = await createUser();
    await expectRefusedAtCommit(
      db.$transaction((tx) => purchase(tx, stranger.id, order.id, -PRICE)),
      LEDGER_SIDE,
    );
    expect(await purchasesOf(stranger.id)).toBe(0);
  });

  it("a PURCHASE of another amount for the user's own earlier order cannot commit", async () => {
    const { user, order } = await bareOrder();
    await expectRefusedAtCommit(
      db.$transaction((tx) => purchase(tx, user.id, order.id, -(PRICE - 1n))),
      LEDGER_SIDE,
    );
    expect(await purchasesOf(user.id)).toBe(0);
  });

  it("the exact debit of the user's own earlier order commits", async () => {
    const { user, order } = await bareOrder();
    await db.$transaction((tx) => purchase(tx, user.id, order.id, -PRICE));
    expect(await purchasesOf(user.id)).toBe(1);
  });
});
