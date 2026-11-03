import {
  CatalogCategorySchema,
  CatalogProductDetailSchema,
  CatalogProductListItemSchema,
} from '@repo/shared';
import type { ProductDisplayPrices } from '../../pricing/price-book.types';
import type { CatalogProductRow, CategoryWithCount } from '../catalog.repository';
import { toCategory, toDetail, toListItem } from '../entities/catalog.mapper';

const AT = new Date('2026-06-01T12:00:00.000Z');

function row(overrides: Partial<CatalogProductRow> = {}): CatalogProductRow {
  return {
    id: 'prod1',
    slug: 'telegram-stars',
    categoryId: 'cat1',
    category: { slug: 'telegram' },
    nameUz: 'Telegram Stars',
    nameRu: 'Telegram Stars',
    descriptionUz: 'Yulduzlar tezda yetkaziladi',
    descriptionRu: 'Звёзды доставляются быстро',
    helpUz: 'Foydalanuvchi nomini @ belgisisiz kiriting',
    helpRu: 'Введите имя пользователя без @',
    imageUrl: '/images/telegram-stars.png',
    regionBadge: 'GLOBAL',
    deliveryType: 'TG_USERNAME',
    inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
    isAuto: true,
    isFeatured: true,
    isActive: true,
    allowCustomQty: true,
    minQty: 50,
    maxQty: 100_000,
    sort: 1,
    createdAt: AT,
    updatedAt: AT,
    skus: [
      {
        id: 'sku50',
        productId: 'prod1',
        tab: null,
        labelUz: '50 ⭐',
        labelRu: '50 ⭐ звёзд',
        quantity: 50,
        supplierSku: 'SECRET-SUPPLIER-CODE',
        markupBps: 1000,
        minMarginTiyin: 12_345n,
        isActive: true,
        sort: 1,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    ...overrides,
  };
}

const PRICES: ProductDisplayPrices = {
  fromPriceTiyin: 550_000n,
  unitPriceTiyin: 11_000n,
  skuPriceTiyin: new Map([['sku50', 550_000n]]),
};

describe('toCategory', () => {
  const category: CategoryWithCount = {
    id: 'c1',
    slug: 'telegram',
    nameUz: 'Telegram',
    nameRu: 'Телеграм',
    sort: 1,
    createdAt: AT,
    updatedAt: AT,
    activeProductCount: 2,
  };

  it('localises the name and exposes only slug, name and productCount', () => {
    expect(toCategory(category, 'uz')).toEqual({
      slug: 'telegram',
      name: 'Telegram',
      productCount: 2,
    });
    expect(toCategory(category, 'ru')).toEqual({
      slug: 'telegram',
      name: 'Телеграм',
      productCount: 2,
    });
    expect(CatalogCategorySchema.safeParse(toCategory(category, 'ru')).success).toBe(true);
  });
});

describe('toListItem', () => {
  it('matches the list contract, in either locale, with the price as a string', () => {
    const item = toListItem(row(), 'ru', PRICES, true);
    expect(item).toEqual({
      id: 'prod1',
      slug: 'telegram-stars',
      categorySlug: 'telegram',
      name: 'Telegram Stars',
      imageUrl: '/images/telegram-stars.png',
      regionBadge: 'GLOBAL',
      deliveryType: 'TG_USERNAME',
      isAuto: true,
      isFeatured: true,
      inStock: true,
      fromPriceTiyin: '550000',
    });
    expect(CatalogProductListItemSchema.safeParse(item).success).toBe(true);
  });

  it('a missing or empty price becomes null, never "0" or undefined', () => {
    expect(toListItem(row(), 'uz', undefined, true).fromPriceTiyin).toBeNull();
    const none: ProductDisplayPrices = {
      fromPriceTiyin: null,
      unitPriceTiyin: null,
      skuPriceTiyin: new Map(),
    };
    expect(toListItem(row(), 'uz', none, false)).toMatchObject({
      fromPriceTiyin: null,
      inStock: false,
    });
  });
});

describe('toDetail', () => {
  it('picks every localised field by locale', () => {
    const uz = toDetail(row(), 'uz', PRICES, null);
    const ru = toDetail(row(), 'ru', PRICES, null);
    expect([uz.description, uz.help, uz.skus[0]?.label]).toEqual([
      'Yulduzlar tezda yetkaziladi',
      'Foydalanuvchi nomini @ belgisisiz kiriting',
      '50 ⭐',
    ]);
    expect([ru.description, ru.help, ru.skus[0]?.label]).toEqual([
      'Звёзды доставляются быстро',
      'Введите имя пользователя без @',
      '50 ⭐ звёзд',
    ]);
    expect(uz.name).toBe(ru.name);
  });

  it('matches the detail contract and never leaks cost-side columns', () => {
    const detail = toDetail(row(), 'uz', PRICES, null);
    expect(CatalogProductDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      unitPriceTiyin: '11000',
      stock: null,
      currency: 'UZS',
      inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
      skus: [{ id: 'sku50', quantity: 50, tab: null, fromPriceTiyin: '550000' }],
    });
    const wire = JSON.stringify(detail);
    for (const secret of [
      'SECRET-SUPPLIER-CODE',
      'markupBps',
      'minMarginTiyin',
      '12345',
      'supplierSku',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('stays JSON-safe (no BigInt) and nulls absent text and prices', () => {
    const bare = toDetail(
      row({ descriptionUz: null, descriptionRu: null, helpUz: null, helpRu: null }),
      'ru',
      undefined,
      0,
    );
    expect(() => JSON.stringify(bare)).not.toThrow();
    expect(bare).toMatchObject({
      description: null,
      help: null,
      unitPriceTiyin: null,
      stock: 0,
      skus: [{ fromPriceTiyin: null }],
    });
  });

  it('does not fall back to the other language for a missing translation', () => {
    expect(toDetail(row({ helpRu: null }), 'ru', PRICES, null).help).toBeNull();
  });

  it('a malformed stored inputSchema is a loud error, not a response', () => {
    expect(() =>
      toDetail(row({ inputSchema: [{ key: 'x', type: 'nope' }] }), 'uz', PRICES, null),
    ).toThrow();
  });
});
