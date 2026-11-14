import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/index';
import { expectGuard } from './check-helpers';
import { db } from './client';
import { createIntent, createOrder, createUser } from './factories';
import { walkTo } from './order-fixtures';

// Prisma maps Postgres 23505 -> P2002 and 23503 -> P2003, whichever driver adapter is in use.
async function expectPrismaError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(code);
}

describe('idempotency uniques', () => {
  it('Payment(provider, providerTxnId): a replayed provider transaction is rejected', async () => {
    const user = await createUser();
    const intent = await createIntent(user.id);
    const payment = {
      intentId: intent.id,
      userId: user.id,
      provider: 'CLICK',
      providerTxnId: 'click-txn-1',
      amountTiyin: 1_000_000n,
      status: 'CREATED',
      raw: {},
    } as const;
    await db.payment.create({ data: payment });
    await expectPrismaError(db.payment.create({ data: payment }), 'P2002');
    // Same txn id from another provider is a different transaction (on that provider's own
    // intent: a payment has the provider of its intent).
    const paymeIntent = await db.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'PAYME',
        amountTiyin: 1_000_000n,
        purpose: 'TOPUP',
        idempotencyKey: 'payme-intent',
        requestHash: 'hash-a',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await db.payment.create({
      data: { ...payment, provider: 'PAYME', intentId: paymeIntent.id },
    });
  });

  it('Order(userId, idempotencyKey): the same key cannot create a second order', async () => {
    const user = await createUser();
    await createOrder(user, 'same-key');
    // A second order of the quote of another order: every column equals that quote's (the order
    // guard refuses anything else before the unique is reached), only the key repeats.
    const quote = await db.quote.findUniqueOrThrow({
      where: { id: (await createOrder(user, 'other-key')).quoteId },
    });
    await expectPrismaError(
      db.order.create({
        data: {
          userId: user.id,
          quoteId: quote.id,
          productId: quote.productId,
          quantity: quote.quantity,
          recipient: { username: 'someone' },
          priceTiyin: quote.priceTiyin,
          costCurrency: quote.costCurrency,
          fxRateId: quote.fxRateId,
          costMinor: quote.costMinor,
          maxCostMinor: quote.maxCostMinor,
          status: 'PAID',
          idempotencyKey: 'same-key',
          requestHash: 'hash-a',
        },
      }),
      'P2002',
    );
  });

  it('Order.idempotencyKey is per user: another user may reuse the key', async () => {
    const a = await createUser();
    const b = await createUser();
    await createOrder(a, 'shared-key');
    await expect(createOrder(b, 'shared-key')).resolves.toMatchObject({
      idempotencyKey: 'shared-key',
    });
  });

  it('Order.quoteId: one quote can back only one order', async () => {
    const user = await createUser();
    const order = await createOrder(user);
    const quote = await db.quote.findUniqueOrThrow({ where: { id: order.quoteId } });
    await expectPrismaError(
      db.order.create({
        data: {
          userId: user.id,
          quoteId: quote.id,
          productId: quote.productId,
          quantity: quote.quantity,
          recipient: { username: 'someone' },
          priceTiyin: quote.priceTiyin,
          costCurrency: quote.costCurrency,
          fxRateId: quote.fxRateId,
          costMinor: quote.costMinor,
          maxCostMinor: quote.maxCostMinor,
          status: 'PAID',
          idempotencyKey: 'another-key',
          requestHash: 'hash-a',
        },
      }),
      'P2002',
    );
  });

  it('PaymentIntent(userId, idempotencyKey)', async () => {
    const user = await createUser();
    await createIntent(user.id, 'intent-key');
    await expectPrismaError(createIntent(user.id, 'intent-key'), 'P2002');
  });

  it('FulfillmentAttempt(orderId, attemptNo): an attempt number is used once', async () => {
    const order = await createOrder(await createUser());
    await walkTo(order.id, 'PROCESSING'); // a payout starts for a PROCESSING order only
    const attempt = {
      orderId: order.id,
      attemptNo: 1,
      adapter: 'FRAGMENT',
      status: 'SENDING',
      request: {},
    } as const;
    await db.fulfillmentAttempt.create({ data: attempt });
    await expectPrismaError(db.fulfillmentAttempt.create({ data: attempt }), 'P2002');
  });

  it('LedgerEntry(refType, refId, kind): a money movement is booked once', async () => {
    const user = await createUser();
    const entry = {
      userId: user.id,
      kind: 'TOPUP',
      amountTiyin: 500_000n,
      refType: 'PAYMENT',
      refId: 'pay_1',
    } as const;
    await db.ledgerEntry.create({ data: entry });
    await expectPrismaError(db.ledgerEntry.create({ data: entry }), 'P2002');
    // A different kind for the same reference (e.g. the reversal) is a distinct entry.
    await db.ledgerEntry.create({
      data: { ...entry, kind: 'TOPUP_REVERSAL', amountTiyin: -500_000n },
    });
  });

  it('CoinEntry(refType, refId, kind)', async () => {
    const user = await createUser();
    const entry = {
      userId: user.id,
      kind: 'EARN',
      coins: 10n,
      refType: 'ORDER',
      refId: 'o_1',
    } as const;
    await db.coinEntry.create({ data: entry });
    await expectPrismaError(db.coinEntry.create({ data: entry }), 'P2002');
  });
});

describe('foreign keys', () => {
  it('rejects a ledger entry for a user that does not exist', async () => {
    await expectPrismaError(
      db.ledgerEntry.create({
        data: { userId: 'ghost', kind: 'TOPUP', amountTiyin: 1n, refType: 'PAYMENT', refId: 'x' },
      }),
      'P2003',
    );
  });

  it('Restrict: a user with ledger history cannot be deleted', async () => {
    const user = await createUser();
    await db.ledgerEntry.create({
      data: { userId: user.id, kind: 'TOPUP', amountTiyin: 1n, refType: 'PAYMENT', refId: 'p' },
    });
    await expectPrismaError(db.user.delete({ where: { id: user.id } }), 'P2003');
    expect(await db.ledgerEntry.count({ where: { userId: user.id } })).toBe(1);
  });

  // Order_no_delete (BEFORE DELETE, review N6) refuses every order DELETE before the foreign key
  // is checked, so the Restrict of OrderEvent -> Order is proven from the catalog instead.
  it('an order with events cannot be deleted; OrderEvent restricts the delete of its order', async () => {
    const order = await createOrder(await createUser());
    await db.orderEvent.create({ data: { orderId: order.id, to: 'PAID', actor: 'SYSTEM' } });
    await expectGuard(db.order.delete({ where: { id: order.id } }), 'is never deleted');
    const rules = await db.$queryRaw<{ rule: string }[]>`
      SELECT confdeltype::text AS rule FROM pg_constraint
      WHERE contype = 'f' AND conrelid = '"OrderEvent"'::regclass
        AND confrelid = '"Order"'::regclass`;
    expect(rules).toEqual([{ rule: 'r' }]);
  });

  it('Cascade is limited to credentials: deleting a user drops its web sessions', async () => {
    const user = await createUser();
    await db.webSession.create({
      data: {
        userId: user.id,
        refreshHash: 'h',
        familyId: 'f',
        expiresAt: new Date(Date.now() + 1000),
      },
    });
    await db.user.delete({ where: { id: user.id } });
    expect(await db.webSession.count()).toBe(0);
  });
});

describe('BigInt money', () => {
  const beyondSafeInteger = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a Number

  it('round-trips a value above 2^53 exactly', async () => {
    expect(BigInt(Number(beyondSafeInteger))).not.toBe(beyondSafeInteger); // a Number would corrupt it
    const user = await createUser();
    const created = await db.ledgerEntry.create({
      data: {
        userId: user.id,
        kind: 'TOPUP',
        amountTiyin: beyondSafeInteger,
        refType: 'PAYMENT',
        refId: 'big',
      },
    });
    expect(created.amountTiyin).toBe(beyondSafeInteger);
    const found = await db.ledgerEntry.findUniqueOrThrow({ where: { id: created.id } });
    expect(found.amountTiyin).toBe(beyondSafeInteger);
  });

  it('SUM over the ledger stays exact above 2^53', async () => {
    const user = await createUser();
    await db.ledgerEntry.createMany({
      data: [
        {
          userId: user.id,
          kind: 'TOPUP',
          amountTiyin: beyondSafeInteger,
          refType: 'PAYMENT',
          refId: 'a',
        },
        { userId: user.id, kind: 'TOPUP', amountTiyin: 2n, refType: 'PAYMENT', refId: 'b' },
        // A debit (not a PURCHASE: that needs its order since D-60).
        {
          userId: user.id,
          kind: 'TOPUP_REVERSAL',
          amountTiyin: -1n,
          refType: 'PAYMENT',
          refId: 'c',
        },
      ],
    });
    const sum = await db.ledgerEntry.aggregate({
      where: { userId: user.id },
      _sum: { amountTiyin: true },
    });
    expect(sum._sum.amountTiyin).toBe(beyondSafeInteger + 1n);
  });
});
