import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/index';
import { expectGuard } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';
import { walkTo } from './order-fixtures';

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

  it('rejects an order that points at a missing FX rate: the order guard refuses any FX rate but the quote one (audit Z4)', async () => {
    // INSERT, not UPDATE: since phase 5 Order.fxRateId is immutable (GG001 trigger). Since Z4 the
    // guard compares it with the quote's, which is itself bound to a real FX rate by its foreign key,
    // so a ghost rate is refused by the guard before the order's own foreign key is reached.
    await expectGuard(
      createOrder(await createUser(), undefined, { fxRateId: 'ghost' }),
      'must equal its quote',
    );
  });
});

describe('FulfillmentAttempt(adapter, externalRef)', () => {
  it('one external payout belongs to one attempt; NULL refs and other adapters are fine', async () => {
    const user = await createUser();
    const a = await createOrder(user);
    const b = await createOrder(user);
    // A payout starts for a PROCESSING order only, and an attempt is born SENDING.
    await walkTo(a.id, 'PROCESSING');
    await walkTo(b.id, 'PROCESSING');
    const base = { adapter: 'FRAGMENT', status: 'SENDING', request: {} } as const;
    const first = await db.fulfillmentAttempt.create({
      data: { ...base, orderId: a.id, attemptNo: 1, externalRef: 'hash-1' },
    });
    await expectPrismaError(
      db.fulfillmentAttempt.create({
        data: { ...base, orderId: b.id, attemptNo: 1, externalRef: 'hash-1' },
      }),
      'P2002',
    );
    const other = await db.fulfillmentAttempt.create({
      data: { ...base, adapter: 'FAZERCARDS', orderId: b.id, attemptNo: 1, externalRef: 'hash-1' },
    });
    // NULL externalRef (attempt not yet sent) never collides. One live attempt per order is
    // enforced (phase 5), so the first attempts fail (they keep their reference) before the retries.
    for (const id of [first.id, other.id]) {
      await db.fulfillmentAttempt.update({ where: { id }, data: { status: 'FAILED' } });
    }
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
