import { readFileSync } from 'node:fs';
import { ProductInputSchema } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { SEED_CATEGORIES } from '../prisma/seed/catalog-data';
import { seedCatalog } from '../prisma/seed/seed-catalog';
import { db } from './client';

// Read from disk (not imported) so packages/db needs no dependency on packages/i18n.
function loadCatalog(file: 'uz.json' | 'ru.json'): unknown {
  return JSON.parse(readFileSync(new URL(`../../i18n/${file}`, import.meta.url), 'utf8'));
}

function lookup(catalog: unknown, dottedKey: string): unknown {
  let node: unknown = catalog;
  for (const part of dottedKey.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

async function counts(): Promise<Record<string, number>> {
  return {
    categories: await db.category.count(),
    products: await db.product.count(),
    routes: await db.productRoute.count(),
    skus: await db.sku.count(),
  };
}

describe('catalog seed', () => {
  it('creates the Telegram catalog with the planned shape', async () => {
    const report = await seedCatalog(db, { activateProducts: true });
    expect(report).toEqual({ categories: 1, products: 2, routes: 3, skus: 9 });

    const stars = await db.product.findUniqueOrThrow({
      where: { slug: 'telegram-stars' },
      include: { skus: { orderBy: { quantity: 'asc' } }, routes: { orderBy: { priority: 'asc' } } },
    });
    expect(stars).toMatchObject({
      deliveryType: 'TG_USERNAME',
      allowCustomQty: true,
      minQty: 50,
      maxQty: 100_000,
      isActive: true,
    });
    expect(stars.skus.map((s) => s.quantity)).toEqual([50, 100, 250, 500, 1000, 2500]);
    expect(stars.skus.every((s) => s.markupBps === 1000 && s.minMarginTiyin === 0n)).toBe(true);
    expect(stars.routes.map((r) => [r.adapter, r.priority, r.isEnabled])).toEqual([
      ['FRAGMENT', 1, true],
      ['RESELLER_STARS', 2, false],
    ]);

    const premium = await db.product.findUniqueOrThrow({
      where: { slug: 'telegram-premium' },
      include: { skus: { orderBy: { quantity: 'asc' } } },
    });
    expect(premium.allowCustomQty).toBe(false);
    expect(premium.skus.map((s) => [s.quantity, s.labelUz, s.labelRu])).toEqual([
      [3, '3 oylik', '3 месяца'],
      [6, '6 oylik', '6 месяцев'],
      [12, '12 oylik', '12 месяцев'],
    ]);
  });

  it('is idempotent: a second run creates nothing and leaves the same rows', async () => {
    await seedCatalog(db, { activateProducts: true });
    const first = await counts();
    const ids = (await db.sku.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(
      (s) => s.id,
    );

    const second = await seedCatalog(db, { activateProducts: true });

    expect(second).toEqual({ categories: 0, products: 0, routes: 0, skus: 0 });
    expect(await counts()).toEqual(first);
    const idsAfter = (await db.sku.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(
      (s) => s.id,
    );
    expect(idsAfter).toEqual(ids);
  });

  it('never overwrites rows that already exist', async () => {
    await seedCatalog(db, { activateProducts: true });
    await db.product.update({
      where: { slug: 'telegram-stars' },
      data: { nameUz: 'Changed by admin', isActive: false },
    });
    await db.sku.updateMany({ where: { quantity: 50 }, data: { markupBps: 1500 } });

    await seedCatalog(db, { activateProducts: true });

    const stars = await db.product.findUniqueOrThrow({ where: { slug: 'telegram-stars' } });
    expect(stars).toMatchObject({ nameUz: 'Changed by admin', isActive: false });
    const sku50 = await db.sku.findFirstOrThrow({ where: { quantity: 50 } });
    expect(sku50.markupBps).toBe(1500);
  });

  it('creates inactive products in production mode', async () => {
    await seedCatalog(db, { activateProducts: false });
    const products = await db.product.findMany();
    expect(products).toHaveLength(2);
    expect(products.every((p) => !p.isActive)).toBe(true);
  });

  it('serialises concurrent runs without duplicates', async () => {
    await Promise.all([
      seedCatalog(db, { activateProducts: true }),
      seedCatalog(db, { activateProducts: true }),
    ]);
    expect(await counts()).toEqual({ categories: 1, products: 2, routes: 3, skus: 9 });
  });

  it('every seeded inputSchema parses with ProductInputSchema', () => {
    for (const category of SEED_CATEGORIES) {
      for (const product of category.products) {
        expect(ProductInputSchema.safeParse(product.inputSchema).success, product.slug).toBe(true);
      }
    }
  });

  it('every stored inputSchema label exists in both i18n catalogs', async () => {
    await seedCatalog(db, { activateProducts: true });
    const uz = loadCatalog('uz.json');
    const ru = loadCatalog('ru.json');
    const products = await db.product.findMany();
    expect(products.length).toBeGreaterThan(0);
    for (const product of products) {
      for (const field of ProductInputSchema.parse(product.inputSchema)) {
        expect(typeof lookup(uz, field.label), `uz ${field.label}`).toBe('string');
        expect(typeof lookup(ru, field.label), `ru ${field.label}`).toBe('string');
      }
    }
  });

  it('writes Uzbek apostrophes as U+2018 / U+02BC only', () => {
    const texts = SEED_CATEGORIES.flatMap((c) =>
      c.products.flatMap((p) => [p.descriptionUz, ...p.skus.map((s) => s.labelUz)]),
    );
    for (const text of texts) {
      expect(text, text).not.toMatch(/['`’]/);
    }
  });
});
