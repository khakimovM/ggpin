import { describe, expect, it } from 'vitest';
import {
  CATALOG_MAX_LIMIT,
  CatalogCategorySchema,
  CatalogListMetaSchema,
  CatalogLocaleQuerySchema,
  CatalogProductDetailSchema,
  CatalogProductListItemSchema,
  ProductListQuerySchema,
  ProductSlugParamsSchema,
} from './catalog-schemas';
import { InputFieldSchema, ProductInputSchema } from './input-schema';

describe('CatalogLocaleQuerySchema', () => {
  it('defaults to uz and accepts uz and ru only', () => {
    expect(CatalogLocaleQuerySchema.parse({})).toEqual({ locale: 'uz' });
    expect(CatalogLocaleQuerySchema.parse({ locale: 'ru' })).toEqual({ locale: 'ru' });
    for (const locale of ['en', 'UZ', '', 'uz-UZ']) {
      expect(CatalogLocaleQuerySchema.safeParse({ locale }).success, locale).toBe(false);
    }
  });

  it('rejects unknown query keys (they would multiply public cache keys)', () => {
    expect(CatalogLocaleQuerySchema.safeParse({ locale: 'uz', cb: '1' }).success).toBe(false);
  });
});

describe('ProductListQuerySchema', () => {
  it('applies defaults and coerces page and limit from query strings', () => {
    expect(ProductListQuerySchema.parse({})).toEqual({ locale: 'uz', page: 1, limit: 20 });
    expect(ProductListQuerySchema.parse({ page: '3', limit: '50', category: 'telegram' })).toEqual({
      locale: 'uz',
      page: 3,
      limit: 50,
      category: 'telegram',
    });
  });

  it('accepts limit 100 and rejects 101, 0, negatives and fractions', () => {
    expect(ProductListQuerySchema.parse({ limit: String(CATALOG_MAX_LIMIT) }).limit).toBe(100);
    for (const limit of ['101', '0', '-1', '1.5', 'abc', '']) {
      expect(ProductListQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
  });

  it('rejects page 0 and absurd pages', () => {
    for (const page of ['0', '-2', '10001', 'x']) {
      expect(ProductListQuerySchema.safeParse({ page }).success, page).toBe(false);
    }
  });

  it('trims q, treats an empty q as no filter, and caps its length at 64', () => {
    expect(ProductListQuerySchema.parse({ q: '  stars ' }).q).toBe('stars');
    expect(ProductListQuerySchema.parse({ q: '   ' }).q).toBeUndefined();
    expect(ProductListQuerySchema.safeParse({ q: 'a'.repeat(64) }).success).toBe(true);
    expect(ProductListQuerySchema.safeParse({ q: 'a'.repeat(65) }).success).toBe(false);
  });

  it('allows only slug-shaped categories', () => {
    expect(ProductListQuerySchema.safeParse({ category: 'game-top-ups' }).success).toBe(true);
    for (const category of ['Telegram', 'a_b', '-a', 'a--b', 'a b', '', 'x'.repeat(65)]) {
      expect(ProductListQuerySchema.safeParse({ category }).success, category).toBe(false);
    }
  });

  it('rejects other locales and unknown keys', () => {
    expect(ProductListQuerySchema.safeParse({ locale: 'en' }).success).toBe(false);
    expect(ProductListQuerySchema.safeParse({ sort: 'price' }).success).toBe(false);
  });
});

describe('ProductSlugParamsSchema', () => {
  it('accepts a slug and rejects anything else', () => {
    expect(ProductSlugParamsSchema.safeParse({ slug: 'telegram-stars' }).success).toBe(true);
    expect(ProductSlugParamsSchema.safeParse({ slug: '../etc' }).success).toBe(false);
    expect(ProductSlugParamsSchema.safeParse({ slug: 'a', extra: 1 }).success).toBe(false);
  });
});

describe('response schemas', () => {
  const item = {
    id: 'p1',
    slug: 'telegram-stars',
    categorySlug: 'telegram',
    name: 'Telegram Stars',
    imageUrl: '/assets/stars.png',
    regionBadge: 'GLOBAL',
    deliveryType: 'TG_USERNAME',
    isAuto: true,
    isFeatured: true,
    inStock: true,
    fromPriceTiyin: '1100000',
  };

  it('category: productCount is at least 1', () => {
    expect(
      CatalogCategorySchema.safeParse({ slug: 'telegram', name: 'Telegram', productCount: 2 })
        .success,
    ).toBe(true);
    expect(
      CatalogCategorySchema.safeParse({ slug: 'telegram', name: 'Telegram', productCount: 0 })
        .success,
    ).toBe(false);
  });

  it('list item: money is a string or null, never a number', () => {
    expect(CatalogProductListItemSchema.safeParse(item).success).toBe(true);
    expect(CatalogProductListItemSchema.safeParse({ ...item, fromPriceTiyin: null }).success).toBe(
      true,
    );
    expect(
      CatalogProductListItemSchema.safeParse({ ...item, fromPriceTiyin: 1100000 }).success,
    ).toBe(false);
    expect(CatalogProductListItemSchema.safeParse({ ...item, fromPriceTiyin: '-5' }).success).toBe(
      false,
    );
    expect(CatalogProductListItemSchema.safeParse({ ...item, fromPriceTiyin: '01' }).success).toBe(
      false,
    );
    expect(
      CatalogProductListItemSchema.safeParse({ ...item, fromPriceTiyin: '9223372036854775808' })
        .success,
    ).toBe(false);
    expect(
      CatalogProductListItemSchema.safeParse({ ...item, deliveryType: 'CARRIER_PIGEON' }).success,
    ).toBe(false);
  });

  it('list meta: limit stays within 100', () => {
    expect(CatalogListMetaSchema.safeParse({ page: 1, limit: 100, total: 0 }).success).toBe(true);
    expect(CatalogListMetaSchema.safeParse({ page: 1, limit: 101, total: 0 }).success).toBe(false);
  });

  const detail = {
    id: 'p1',
    slug: 'telegram-stars',
    name: 'Telegram Stars',
    description: null,
    help: null,
    imageUrl: '/assets/stars.png',
    deliveryType: 'TG_USERNAME',
    regionBadge: 'GLOBAL',
    isAuto: true,
    allowCustomQty: true,
    minQty: 50,
    maxQty: 100000,
    inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
    skus: [
      { id: 'sku_50', label: '50 ⭐', quantity: 50, tab: null, fromPriceTiyin: '1100000' },
      { id: 'sku_100', label: '100 ⭐', quantity: 100, tab: null, fromPriceTiyin: null },
    ],
    unitPriceTiyin: '22000',
    stock: null,
    currency: 'UZS',
  };

  it('detail: the docs/04 sample shape parses', () => {
    expect(CatalogProductDetailSchema.safeParse(detail).success).toBe(true);
  });

  it('detail: custom quantity needs both bounds and min <= max', () => {
    expect(CatalogProductDetailSchema.safeParse({ ...detail, minQty: null }).success).toBe(false);
    expect(CatalogProductDetailSchema.safeParse({ ...detail, maxQty: null }).success).toBe(false);
    expect(
      CatalogProductDetailSchema.safeParse({ ...detail, minQty: 200, maxQty: 100 }).success,
    ).toBe(false);
    expect(
      CatalogProductDetailSchema.safeParse({ ...detail, minQty: 50, maxQty: 50 }).success,
    ).toBe(true);
    expect(
      CatalogProductDetailSchema.safeParse({
        ...detail,
        allowCustomQty: false,
        minQty: null,
        maxQty: null,
      }).success,
    ).toBe(true);
    expect(
      CatalogProductDetailSchema.safeParse({
        ...detail,
        allowCustomQty: false,
        minQty: 9,
        maxQty: 3,
      }).success,
    ).toBe(false);
  });

  it('detail: currency is UZS and stock is a non-negative integer or null', () => {
    expect(CatalogProductDetailSchema.safeParse({ ...detail, currency: 'USD' }).success).toBe(
      false,
    );
    expect(CatalogProductDetailSchema.safeParse({ ...detail, stock: 0 }).success).toBe(true);
    expect(CatalogProductDetailSchema.safeParse({ ...detail, stock: -1 }).success).toBe(false);
  });

  it('detail: an invalid inputSchema is rejected', () => {
    const bad = [{ key: 'u', type: 'digits', label: 'fields.x' }];
    expect(CatalogProductDetailSchema.safeParse({ ...detail, inputSchema: bad }).success).toBe(
      false,
    );
  });
});

describe('InputFieldSchema / ProductInputSchema', () => {
  const field = { key: 'username', type: 'tgUsername', label: 'fields.tgUsername' };

  it('accepts the phase 3 tgUsername field', () => {
    expect(InputFieldSchema.parse(field)).toEqual(field);
    expect(ProductInputSchema.parse([field])).toEqual([field]);
    expect(ProductInputSchema.parse([])).toEqual([]);
  });

  it('rejects unknown types, extra keys, and labels that are not i18n keys', () => {
    expect(InputFieldSchema.safeParse({ ...field, type: 'playerId' }).success).toBe(false);
    expect(InputFieldSchema.safeParse({ ...field, min: 5 }).success).toBe(false);
    for (const label of ['Telegram username', 'fields', 'fields.', '.fields', '']) {
      expect(InputFieldSchema.safeParse({ ...field, label }).success, label).toBe(false);
    }
    expect(InputFieldSchema.safeParse({ ...field, key: 'Bad Key' }).success).toBe(false);
  });

  it('allows at most 8 fields and no duplicate keys', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...field, key: `field${index}` }));
    expect(ProductInputSchema.safeParse(many(8)).success).toBe(true);
    expect(ProductInputSchema.safeParse(many(9)).success).toBe(false);
    expect(ProductInputSchema.safeParse([field, field]).success).toBe(false);
  });
});
