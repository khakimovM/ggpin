import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/index';
import { db } from './client';
import { createOrder, createUser } from './factories';

async function expectPrismaError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(code);
}

describe('Order.fxRateId', () => {
  it('stores the FX snapshot id and Restrict-protects the rate row', async () => {
    const order = await createOrder(await createUser());
    expect(order.fxRateId).toEqual(expect.any(String));
    await expectPrismaError(db.fxRate.delete({ where: { id: order.fxRateId } }), 'P2003');
  });

  it('rejects an order that points at a missing FX rate', async () => {
    const order = await createOrder(await createUser());
    await expectPrismaError(
      db.order.update({ where: { id: order.id }, data: { fxRateId: 'ghost' } }),
      'P2003',
    );
  });
});

describe('FulfillmentAttempt(adapter, externalRef)', () => {
  it('one external payout belongs to one attempt; NULL refs and other adapters are fine', async () => {
    const user = await createUser();
    const a = await createOrder(user);
    const b = await createOrder(user);
    const base = { adapter: 'FRAGMENT', status: 'SENT', request: {} } as const;
    await db.fulfillmentAttempt.create({
      data: { ...base, orderId: a.id, attemptNo: 1, externalRef: 'hash-1' },
    });
    await expectPrismaError(
      db.fulfillmentAttempt.create({
        data: { ...base, orderId: b.id, attemptNo: 1, externalRef: 'hash-1' },
      }),
      'P2002',
    );
    await db.fulfillmentAttempt.create({
      data: { ...base, adapter: 'FAZERCARDS', orderId: b.id, attemptNo: 1, externalRef: 'hash-1' },
    });
    // NULL externalRef (attempt not yet sent) never collides.
    await db.fulfillmentAttempt.create({ data: { ...base, orderId: a.id, attemptNo: 2 } });
    await db.fulfillmentAttempt.create({ data: { ...base, orderId: b.id, attemptNo: 2 } });
  });
});

describe('LedgerKind.REFERRAL_BONUS_REVERSAL', () => {
  it('reverses a referral bonus alongside the original (distinct kind, same reference)', async () => {
    const user = await createUser();
    const entry = { userId: user.id, refType: 'REFERRAL', refId: 'o1' } as const;
    await db.ledgerEntry.create({ data: { ...entry, kind: 'REFERRAL_BONUS', amountTiyin: 100n } });
    await db.ledgerEntry.create({
      data: { ...entry, kind: 'REFERRAL_BONUS_REVERSAL', amountTiyin: -100n },
    });
    const sum = await db.ledgerEntry.aggregate({
      where: { userId: user.id },
      _sum: { amountTiyin: true },
    });
    expect(sum._sum.amountTiyin).toBe(0n);
  });

  it('several admin partial refunds of one order do not collide (ADMIN_ACTION/<AuditLog.id>)', async () => {
    const user = await createUser();
    const base = {
      userId: user.id,
      kind: 'REFUND',
      amountTiyin: 50n,
      refType: 'ADMIN_ACTION',
    } as const;
    await db.ledgerEntry.create({ data: { ...base, refId: 'audit-1' } });
    await db.ledgerEntry.create({ data: { ...base, refId: 'audit-2' } });
    // The same audited action cannot be booked twice.
    await expectPrismaError(
      db.ledgerEntry.create({ data: { ...base, refId: 'audit-2' } }),
      'P2002',
    );
  });
});

describe('createdAt on config tables', () => {
  it('Category, Sku, ProductRoute, DiscountTier, Setting, FragmentSession all have createdAt', async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'createdAt'
        AND table_name IN ('Category','Sku','ProductRoute','DiscountTier','Setting','FragmentSession')`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'Category',
      'DiscountTier',
      'FragmentSession',
      'ProductRoute',
      'Setting',
      'Sku',
    ]);
  });
});
