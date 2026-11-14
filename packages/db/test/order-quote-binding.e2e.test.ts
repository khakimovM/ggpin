import { describe, expect, it } from 'vitest';
import { expectGuard } from './check-helpers';
import { db } from './client';
import { createQuote, createUser } from './factories';
import { uniqueHash } from './order-fixtures';

// Audit Y6 and Z4 (D-59 B11, F): an order is created for exactly what its quote fixed (owner,
// product, sku, quantity, recipient, providerRef, price, cost, ceiling, FX snapshot). The quote has no
// discount amount (only discountCodeId): without a discount code the order's discount must be 0; how a
// code's amount is bound is decided with discount codes (phase 10, docs/06).

const MUST = 'must equal its quote';

type QuoteRow = Awaited<ReturnType<typeof createQuote>>;

// The order with its PURCHASE debit in one transaction (D-60 demands the pair at COMMIT); a refused
// order fails at its INSERT, before the debit.
const orderFor = (quote: QuoteRow, overrides: Record<string, unknown> = {}) =>
  db.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        userId: quote.userId,
        quoteId: quote.id,
        productId: quote.productId,
        skuId: quote.skuId,
        quantity: quote.quantity,
        recipient: quote.recipient ?? {},
        providerRef: quote.providerRef,
        priceTiyin: quote.priceTiyin,
        costCurrency: quote.costCurrency,
        fxRateId: quote.fxRateId,
        costMinor: quote.costMinor,
        maxCostMinor: quote.maxCostMinor,
        status: 'PAID',
        idempotencyKey: `qb-${uniqueHash()}`,
        requestHash: 'h',
        ...overrides,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        userId: order.userId,
        kind: 'PURCHASE',
        amountTiyin: -(order.priceTiyin - order.discountTiyin),
        refType: 'ORDER',
        refId: order.id,
      },
    });
    return order;
  });

describe('the order of its own quote', () => {
  it('copies every fixed column: created, with or without a providerRef', async () => {
    const user = await createUser();
    const plain = await createQuote(user.id);
    expect((await orderFor(plain)).providerRef).toBeNull();
    const withRef = await createQuote(user.id, { providerRef: 'tg-user-77' });
    expect((await orderFor(withRef)).providerRef).toBe('tg-user-77');
  });

  it('one differing column at a time is refused (GG001), for every column of the quote', async () => {
    const user = await createUser();
    const quote = await createQuote(user.id, { providerRef: 'tg-user-77' });
    const other = await createQuote((await createUser()).id);
    const sku = await db.sku.create({
      data: { productId: quote.productId, labelUz: 'a', labelRu: 'b', quantity: 3, markupBps: 0 },
    });
    const differences: Record<string, unknown>[] = [
      { userId: other.userId },
      { productId: other.productId },
      { skuId: sku.id },
      { quantity: quote.quantity + 1 },
      { recipient: { username: 'somebody_else' } },
      { providerRef: 'tg-user-99' },
      { providerRef: null },
      { priceTiyin: 1n },
      { priceTiyin: quote.priceTiyin + 1n },
      { costCurrency: 'USDT' },
      { costMinor: quote.costMinor + 1n },
      { maxCostMinor: quote.maxCostMinor + 1n },
      { fxRateId: other.fxRateId },
      { discountTiyin: 1n },
    ];
    for (const difference of differences) {
      await expectGuard(orderFor(quote, difference), MUST);
    }
    expect(await db.order.count({ where: { quoteId: quote.id } })).toBe(0);
  });

  it("another user's quote with a price of one tiyin is refused (Z4 probe Q4b)", async () => {
    const owner = await createUser();
    const thief = await createUser();
    const quote = await createQuote(owner.id);
    await expectGuard(orderFor(quote, { userId: thief.id, priceTiyin: 1n }), MUST);
    await expectGuard(orderFor(quote, { userId: thief.id }), MUST);
    await orderFor(quote);
  });

  it('a quote without a discount code gives an order without a discount', async () => {
    const quote = await createQuote((await createUser()).id);
    expect(quote.discountCodeId).toBeNull();
    await expectGuard(orderFor(quote, { discountTiyin: quote.priceTiyin / 2n }), MUST);
    expect((await orderFor(quote, { discountTiyin: 0n })).discountTiyin).toBe(0n);
  });

  it('an expired quote, even one never used, gives no order (audit R4-3)', async () => {
    const user = await createUser();
    // An hour past: the database clock may differ from this process's by a second or two.
    const expired = await createQuote(user.id, { expiresAt: new Date(Date.now() - 3_600_000) });
    expect(expired.usedAt).toBeNull();
    await expectGuard(orderFor(expired), 'cannot be created from an expired quote');
    expect(await db.order.count({ where: { quoteId: expired.id } })).toBe(0);
    await orderFor(await createQuote(user.id, { expiresAt: new Date(Date.now() + 60_000) }));
  });
});
