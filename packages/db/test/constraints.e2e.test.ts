import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/index';
import { db } from './client';
import { createIntent, createOrder, createUser } from './factories';

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
      provider: 'CLICK',
      providerTxnId: 'click-txn-1',
      amountTiyin: 1_000_000n,
      status: 'CREATED',
      raw: {},
    } as const;
    await db.payment.create({ data: payment });
    await expectPrismaError(db.payment.create({ data: payment }), 'P2002');
    // Same txn id from another provider is a different transaction.
    await db.payment.create({ data: { ...payment, provider: 'PAYME' } });
  });

  it('Order(userId, idempotencyKey): the same key cannot create a second order', async () => {
    const user = await createUser();
    const first = await createOrder(user, 'same-key');
    await expectPrismaError(
      db.order.create({
        data: {
          userId: user.id,
          quoteId: (await createOrder(user, 'other-key')).quoteId,
          productId: first.productId,
          quantity: 1,
          recipient: {},
          priceTiyin: 1n,
          costCurrency: 'TON',
          fxRateId: first.fxRateId,
          costMinor: 1n,
          maxCostMinor: 1n,
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
    await expectPrismaError(
      db.order.create({
        data: {
          userId: user.id,
          quoteId: order.quoteId,
          productId: order.productId,
          quantity: 1,
          recipient: {},
          priceTiyin: 1n,
          costCurrency: 'TON',
          fxRateId: order.fxRateId,
          costMinor: 1n,
          maxCostMinor: 1n,
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

  it('Restrict: an order with events cannot be deleted', async () => {
    const order = await createOrder(await createUser());
    await db.orderEvent.create({ data: { orderId: order.id, to: 'PAID', actor: 'SYSTEM' } });
    await expectPrismaError(db.order.delete({ where: { id: order.id } }), 'P2003');
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
        { userId: user.id, kind: 'PURCHASE', amountTiyin: -1n, refType: 'ORDER', refId: 'c' },
      ],
    });
    const sum = await db.ledgerEntry.aggregate({
      where: { userId: user.id },
      _sum: { amountTiyin: true },
    });
    expect(sum._sum.amountTiyin).toBe(beyondSafeInteger + 1n);
  });
});
