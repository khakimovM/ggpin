import { describe, expect, it } from 'vitest';
import type { Prisma } from '../src/index';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createOrder, createQuote, createUser } from './factories';
import { bypassingGuards, forceAttempt, walkTo } from './order-fixtures';

// Phase 5 (migration 10, part 2): the CHECK constraints, partial unique indexes and triggers of
// FragmentSession, Order and Quote, each with an accepted and a refused case. TonTransfer,
// FulfillmentAttempt and the Order status machine have their own files.

let counter = 0;
const next = (): number => ++counter;

describe('FragmentSession', () => {
  const session = (status: string, deadAt: Date | null = null) =>
    db.fragmentSession.create({ data: { cookiesEnc: 'enc', status, deadAt } });

  it('accepts ACTIVE and DEAD only', async () => {
    await session('DEAD', new Date());
    for (const status of ['', 'active', 'ALIVE', 'ACTIVE ']) {
      await expectCheck(session(status), 'FragmentSession_status_check');
    }
  });

  it('only one session is ACTIVE; any number may be DEAD', async () => {
    await session('ACTIVE');
    await expectPrismaCode(session('ACTIVE'), 'P2002');
    await session('DEAD', new Date());
    await session('DEAD', new Date());
  });

  it('a dead session makes room for a new ACTIVE one', async () => {
    const active = await session('ACTIVE');
    await db.fragmentSession.update({
      where: { id: active.id },
      data: { status: 'DEAD', deadAt: new Date() },
    });
    await session('ACTIVE');
  });
});

describe('Order: delivered has a time, the purchase is immutable', () => {
  it('DELIVERED gets its deliveredAt from the database guard (audit Y11); the CHECK still holds for a write that skips the guards', async () => {
    const order = await createOrder(await createUser());
    await walkTo(order.id, 'PROCESSING');
    await forceAttempt(order.id, 'CONFIRMED');
    // The caller names no delivery time, and one it names is overwritten with the database clock.
    const delivered = await db.order.update({
      where: { id: order.id },
      data: { status: 'DELIVERED' },
    });
    expect(delivered.deliveredAt).not.toBeNull();
    const skipped = await createOrder(await createUser());
    await walkTo(skipped.id, 'PROCESSING');
    await expectCheck(
      bypassingGuards((tx) =>
        tx.order.update({ where: { id: skipped.id }, data: { status: 'DELIVERED' } }),
      ),
      'Order_delivered_at_check',
    );
  });

  it('every purchase column is immutable (GG001), field by field', async () => {
    const order = await createOrder(await createUser());
    const other = await createOrder(await createUser());
    const sku = await db.sku.create({
      data: { productId: order.productId, labelUz: 'a', labelRu: 'b', quantity: 3, markupBps: 0 },
    });
    const changes: Prisma.OrderUncheckedUpdateInput[] = [
      { number: order.number + 1000 },
      { createdAt: new Date(0) },
      { userId: other.userId },
      { quoteId: other.quoteId },
      { productId: other.productId },
      { skuId: sku.id },
      { quantity: order.quantity + 1 },
      { recipient: { username: 'someone_else' } },
      { priceTiyin: order.priceTiyin + 1n },
      { discountTiyin: 1n },
      { costCurrency: 'USDT' },
      { costMinor: order.costMinor + 1n },
      { maxCostMinor: order.maxCostMinor + 1n },
      { fxRateId: other.fxRateId },
      { idempotencyKey: 'another-key-1' },
      { requestHash: 'another-hash' },
    ];
    for (const data of changes) {
      await expectGuard(db.order.update({ where: { id: order.id }, data }), 'immutable');
    }
  });

  it('the order number and the creation time cannot be rewritten (F9)', async () => {
    const order = await createOrder(await createUser());
    await expectGuard(
      db.order.update({ where: { id: order.id }, data: { number: 999_999 } }),
      'immutable',
    );
    await expectGuard(
      db.order.update({ where: { id: order.id }, data: { createdAt: new Date(0) } }),
      'immutable',
    );
  });

  it('status, statusReason, deliveredAt and the same values stay writable', async () => {
    const order = await createOrder(await createUser());
    await walkTo(order.id, 'HELD');
    await db.order.update({ where: { id: order.id }, data: { statusReason: 'LOW_BALANCE' } });
    await db.order.update({
      where: { id: order.id },
      data: { status: 'QUEUED', statusReason: null },
    });
    await db.order.update({
      where: { id: order.id },
      data: { status: 'PROCESSING' },
    });
    await forceAttempt(order.id, 'CONFIRMED');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'DELIVERED' },
    });
    // Re-writing a column with its current value is not a change.
    await db.order.update({
      where: { id: order.id },
      data: {
        priceTiyin: order.priceTiyin,
        number: order.number,
        createdAt: order.createdAt,
        recipient: { username: 'someone' },
      },
    });
  });
});

describe('Quote: the locked price never changes, usedAt is one-way and only while the quote lives', () => {
  it('the quoted numbers, owner, expiry and creation time are immutable (GG001), field by field', async () => {
    const quote = await createQuote((await createUser()).id);
    const other = await createQuote((await createUser()).id);
    const sku = await db.sku.create({
      data: { productId: quote.productId, labelUz: 'a', labelRu: 'b', quantity: 3, markupBps: 0 },
    });
    const tier = await db.discountTier.create({ data: { bps: 100, priceCoins: 1n } });
    const code = await db.discountCode.create({
      data: { userId: quote.userId, tierId: tier.id, bps: 100, code: `C${next()}` },
    });
    const changes: Prisma.QuoteUncheckedUpdateInput[] = [
      { createdAt: new Date(0) },
      { userId: other.userId },
      { skuId: sku.id },
      { productId: other.productId },
      { quantity: quote.quantity + 1 },
      { recipient: { username: 'someone_else' } },
      { costCurrency: 'USDT' },
      { costMinor: quote.costMinor + 1n },
      { fxRateId: other.fxRateId },
      { costSnapshotId: other.costSnapshotId },
      { priceTiyin: quote.priceTiyin + 1n },
      { maxCostMinor: quote.maxCostMinor + 1n },
      { discountCodeId: code.id },
      { expiresAt: new Date(quote.expiresAt.getTime() + 600_000) },
    ];
    for (const data of changes) {
      await expectGuard(db.quote.update({ where: { id: quote.id }, data }), 'immutable');
    }
  });

  it('usedAt goes NULL -> a time exactly once and never back or elsewhere', async () => {
    const quote = await createQuote((await createUser()).id);
    const usedAt = new Date('2026-11-11T10:00:00.000Z');
    await db.quote.update({ where: { id: quote.id }, data: { usedAt } });
    await expectGuard(
      db.quote.update({ where: { id: quote.id }, data: { usedAt: null } }),
      'usedAt',
    );
    await expectGuard(
      db.quote.update({
        where: { id: quote.id },
        data: { usedAt: new Date('2026-11-11T11:00:00.000Z') },
      }),
      'usedAt',
    );
    // The same value again is not a change.
    await db.quote.update({ where: { id: quote.id }, data: { usedAt } });
  });

  it('an expired quote cannot be used: the database refuses it as a backstop', async () => {
    const user = await createUser();
    // An hour past: the database clock may differ from this process's by a second or two.
    const expired = await createQuote(user.id, { expiresAt: new Date(Date.now() - 3_600_000) });
    await expectGuard(
      db.quote.update({ where: { id: expired.id }, data: { usedAt: new Date() } }),
      'expired quote',
    );
    expect((await db.quote.findUniqueOrThrow({ where: { id: expired.id } })).usedAt).toBeNull();
    const live = await createQuote(user.id, { expiresAt: new Date(Date.now() + 60_000) });
    await db.quote.update({ where: { id: live.id }, data: { usedAt: new Date() } });
  });

  it('a quote that expired AFTER it was used stays used: rewriting the same usedAt is fine', async () => {
    const user = await createUser();
    const quote = await createQuote(user.id, { expiresAt: new Date(Date.now() + 60_000) });
    const usedAt = new Date();
    await db.quote.update({ where: { id: quote.id }, data: { usedAt } });
    await db.$executeRaw`UPDATE "Quote" SET "usedAt" = "usedAt" WHERE "id" = ${quote.id}`;
  });
});

describe('BankMessage(source, tgMessageId) index (phase 4 N3)', () => {
  it('exists, and the plain unique index of the table is untouched', async () => {
    const rows = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'BankMessage' ORDER BY indexname`;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('BankMessage_source_tgMessageId_idx');
    expect(names).toContain('BankMessage_senderId_tgMessageId_key');
  });
});
