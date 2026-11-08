import type { CatalogProductDetail } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  checkQuantity,
  isInStock,
  isSupported,
  layoutOf,
  parseQuantity,
  selectionOf,
} from '../selection';

const sku = (id: string, quantity: number, tab: string | null = null) => ({
  id,
  label: `${quantity}`,
  quantity,
  tab,
  fromPriceTiyin: '100000',
});

const stars: CatalogProductDetail = {
  id: 'p_stars',
  slug: 'telegram-stars',
  name: 'Telegram Stars',
  description: null,
  help: null,
  imageUrl: '/assets/products/telegram-stars.svg',
  deliveryType: 'TG_USERNAME',
  regionBadge: null,
  isAuto: true,
  allowCustomQty: true,
  minQty: 50,
  maxQty: 100_000,
  inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
  skus: [sku('s50', 50), sku('s100', 100)],
  unitPriceTiyin: '22000',
  stock: null,
  currency: 'UZS',
};
const premium: CatalogProductDetail = {
  ...stars,
  id: 'p_premium',
  slug: 'telegram-premium',
  allowCustomQty: false,
  minQty: null,
  maxQty: null,
  skus: [sku('m3', 3), sku('m6', 6)],
  unitPriceTiyin: null,
};

describe('quantity bounds', () => {
  it('accepts only whole numbers inside minQty..maxQty', () => {
    expect(checkQuantity('50', 50, 100_000)).toEqual({ ok: true, quantity: 50 });
    expect(checkQuantity('100000', 50, 100_000)).toEqual({ ok: true, quantity: 100_000 });
    expect(checkQuantity('49', 50, 100_000).ok).toBe(false);
    expect(checkQuantity('100001', 50, 100_000).ok).toBe(false);
    expect(checkQuantity('', 50, 100_000).ok).toBe(false);
    expect(checkQuantity('0', 50, 100_000).ok).toBe(false);
  });

  it('refuses anything that is not plain digits', () => {
    for (const raw of ['5e1', '50.5', '-50', ' 50', '0x32', '１００']) {
      expect(parseQuantity(raw)).toBeNull();
    }
  });
});

describe('what the quote is asked for', () => {
  it('Stars: the typed quantity (the minimum while untouched), nothing when out of range', () => {
    expect(layoutOf(stars)).toBe('quantity');
    expect(selectionOf(stars, null, null)).toEqual({ kind: 'qty', quantity: 50 });
    expect(selectionOf(stars, null, '250')).toEqual({ kind: 'qty', quantity: 250 });
    expect(selectionOf(stars, null, '10')).toBeNull();
    expect(selectionOf(stars, null, '')).toBeNull();
  });

  it('Premium: the chosen package, nothing for an id the catalog does not list', () => {
    expect(layoutOf(premium)).toBe('skus');
    expect(selectionOf(premium, null, null)).toBeNull();
    expect(selectionOf(premium, 'm6', null)).toEqual({ kind: 'sku', skuId: 'm6' });
    expect(selectionOf(premium, 'gone', null)).toBeNull();
  });
});

describe('what the page can sell', () => {
  it('needs exactly the Telegram username form', () => {
    expect(isSupported(stars)).toBe(true);
    expect(isSupported({ ...stars, inputSchema: [] })).toBe(false);
  });

  it('stock null is unlimited, 0 is sold out', () => {
    expect(isInStock(stars)).toBe(true);
    expect(isInStock({ ...stars, stock: 3 })).toBe(true);
    expect(isInStock({ ...stars, stock: 0 })).toBe(false);
  });
});
