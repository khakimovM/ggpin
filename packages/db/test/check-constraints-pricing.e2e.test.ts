import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/index';
import { expectCheck } from './check-helpers';
import { db } from './client';
import { createOrder, createQuote, createUser } from './factories';

// A CHECK passes when it evaluates to NULL. These tests pin the NULL cases for the nullable
// columns (Product.minQty/maxQty) and confirm the NOT NULL columns cannot slip a NULL through.

async function productId(): Promise<string> {
  return (await createOrder(await createUser())).productId;
}

const snapshot = (id: string) => ({
  productId: id,
  adapter: 'FRAGMENT',
  currency: 'TON',
  basisQuantity: 1,
  costMinor: 25_000_000n,
  source: 'simulator',
});

// The trigger raises GG001 with the "is append-only" text, which the pg adapter keeps.
async function expectImmutable(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const text = String(error instanceof Error ? error.message : error);
  expect(text).toContain('is append-only');
  expect(text).toContain('GG001');
}

describe('CostSnapshot_values_check', () => {
  it('accepts product-level and SKU-level rows in both currencies', async () => {
    const id = await productId();
    const sku = await db.sku.create({
      data: { productId: id, labelUz: 'a', labelRu: 'b', quantity: 3, markupBps: 0 },
    });
    await db.costSnapshot.create({ data: snapshot(id) });
    await db.costSnapshot.create({ data: { ...snapshot(id), currency: 'USDT' } });
    await db.costSnapshot.create({ data: { ...snapshot(id), skuId: sku.id, basisQuantity: 3 } });
  });

  it('rejects non-positive amounts and quantities, unknown currencies, empty text', async () => {
    const id = await productId();
    const bad: Partial<ReturnType<typeof snapshot>>[] = [
      { costMinor: 0n },
      { costMinor: -1n },
      { basisQuantity: 0 },
      { basisQuantity: -1 },
      { currency: 'UZS' },
      { currency: 'ton' },
      { currency: '' },
      { adapter: '' },
      { source: '' },
    ];
    for (const override of bad) {
      await expectCheck(
        db.costSnapshot.create({ data: { ...snapshot(id), ...override } }),
        'CostSnapshot_values_check',
      );
    }
  });

  it('a NULL in any checked column is stopped by NOT NULL, it cannot pass the CHECK as NULL', async () => {
    const id = await productId();
    const before = await db.costSnapshot.count(); // createOrder builds one through createQuote
    for (const column of ['currency', 'adapter', 'source', 'costMinor', 'basisQuantity']) {
      const values: Record<string, string> = {
        currency: "'TON'",
        adapter: "'FRAGMENT'",
        source: "'t'",
        costMinor: '1',
        basisQuantity: '1',
      };
      values[column] = 'NULL';
      const sql =
        'INSERT INTO "CostSnapshot" (id, "productId", currency, adapter, source, "costMinor", "basisQuantity") ' +
        `VALUES ('n-${column}', '${id}', ${values['currency']}, ${values['adapter']}, ${values['source']}, ` +
        `${values['costMinor']}, ${values['basisQuantity']})`;
      const error: unknown = await db.$executeRawUnsafe(sql).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, column).toBeInstanceOf(Error);
      expect(String((error as Error).message), column).toMatch(/null value|not-null|NotNull/i);
    }
    expect(await db.costSnapshot.count()).toBe(before);
  });
});

describe('FxRate_pair_check', () => {
  it('accepts the three pairs and rejects anything else or an empty source', async () => {
    for (const pair of ['USDT_UZS', 'TON_USDT', 'TON_UZS']) {
      await db.fxRate.create({ data: { pair, rate: '1.5', source: 'simulator' } });
    }
    for (const pair of ['UZS_USDT', 'ton_uzs', 'TON_UZS ', 'USDT_TON', '']) {
      await expectCheck(
        db.fxRate.create({ data: { pair, rate: '1.5', source: 's' } }),
        'FxRate_pair_check',
      );
    }
    await expectCheck(
      db.fxRate.create({ data: { pair: 'TON_UZS', rate: '1.5', source: '' } }),
      'FxRate_pair_check',
    );
  });
});

describe('Quote_cost_currency_check', () => {
  it('accepts TON and USDT, rejects other values', async () => {
    // INSERT, not UPDATE: since phase 5 a quote's costCurrency is immutable (GG001 trigger).
    const user = await createUser();
    await createQuote(user.id, { costCurrency: 'USDT' });
    await createQuote(user.id, { costCurrency: 'TON' });
    for (const costCurrency of ['UZS', 'ton', '', 'TON ']) {
      await expectCheck(createQuote(user.id, { costCurrency }), 'Quote_cost_currency_check');
    }
  });
});

describe('Product_custom_qty_check (minQty and maxQty are nullable)', () => {
  it('allowCustomQty requires BOTH bounds; NULL in either is rejected, not passed through', async () => {
    const id = await productId();
    const set = (data: Prisma.ProductUpdateInput) => db.product.update({ where: { id }, data });
    const bad: Prisma.ProductUpdateInput[] = [
      { allowCustomQty: true, minQty: null, maxQty: null },
      { allowCustomQty: true, minQty: 50, maxQty: null },
      { allowCustomQty: true, minQty: null, maxQty: 100 },
    ];
    for (const data of bad) {
      await expectCheck(set(data), 'Product_custom_qty_check');
    }
    await set({ allowCustomQty: true, minQty: 50, maxQty: 100_000 });
  });

  it('without allowCustomQty the bounds are optional', async () => {
    const id = await productId();
    const set = (data: Prisma.ProductUpdateInput) => db.product.update({ where: { id }, data });
    await set({ allowCustomQty: false, minQty: null, maxQty: null });
    await set({ allowCustomQty: false, minQty: 5, maxQty: null });
    await set({ allowCustomQty: false, minQty: 5, maxQty: 10 });
  });
});

describe('FxRate and CostSnapshot are immutable', () => {
  it('UPDATE is rejected by the trigger (GG001) and the row is unchanged', async () => {
    const fx = await db.fxRate.create({ data: { pair: 'TON_UZS', rate: '30000', source: 't' } });
    await expectImmutable(db.fxRate.update({ where: { id: fx.id }, data: { rate: '1' } }));
    await expectImmutable(db.fxRate.updateMany({ data: { source: 'x' } }));
    expect((await db.fxRate.findUniqueOrThrow({ where: { id: fx.id } })).rate).toBe('30000');

    const cost = await db.costSnapshot.create({ data: snapshot(await productId()) });
    await expectImmutable(
      db.costSnapshot.update({ where: { id: cost.id }, data: { costMinor: 1n } }),
    );
    await expectImmutable(db.costSnapshot.updateMany({ data: { source: 'x' } }));
    const after = await db.costSnapshot.findUniqueOrThrow({ where: { id: cost.id } });
    expect(after.costMinor).toBe(25_000_000n);
    expect(after.source).toBe('simulator');
  });

  it('DELETE of a snapshot that a Quote references is refused by the RESTRICT foreign key', async () => {
    const quote = await createQuote((await createUser()).id);
    const error: unknown = await db.costSnapshot
      .delete({ where: { id: quote.costSnapshotId } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
    expect(await db.costSnapshot.count({ where: { id: quote.costSnapshotId } })).toBe(1);
  });

  it('DELETE of an unreferenced snapshot is not blocked (only UPDATE is; FKs guard references)', async () => {
    const cost = await db.costSnapshot.create({ data: snapshot(await productId()) });
    await db.costSnapshot.delete({ where: { id: cost.id } });
  });
});
