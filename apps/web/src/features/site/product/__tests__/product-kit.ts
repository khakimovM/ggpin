import type { CatalogProductDetail } from '@repo/shared';
import type { SiteProductLookup } from '../../catalog-server';

// Catalog answers for the product page tests: Stars (a quantity product with a minimum) and
// Premium (plans), as the API sends them (tiyin strings, `null` for "no fresh price").

const base = {
  description: null,
  help: null,
  imageUrl: '/assets/products/x.svg',
  deliveryType: 'TG_USERNAME' as const,
  regionBadge: null,
  isAuto: true,
  inputSchema: [],
  stock: null,
  currency: 'UZS' as const,
};

export const STARS: CatalogProductDetail = {
  ...base,
  id: 'p_stars',
  slug: 'telegram-stars',
  name: 'Telegram Stars',
  allowCustomQty: true,
  minQty: 50,
  maxQty: 100_000,
  skus: [50, 500, 1000].map((quantity) => ({
    id: `sku_${quantity}`,
    label: `${quantity} ⭐`,
    quantity,
    tab: null,
    fromPriceTiyin: String(quantity * 22_000),
  })),
  unitPriceTiyin: '22000',
};

export const PREMIUM: CatalogProductDetail = {
  ...base,
  id: 'p_premium',
  slug: 'telegram-premium',
  name: 'Telegram Premium',
  allowCustomQty: false,
  minQty: null,
  maxQty: null,
  skus: [
    { id: 'sku_3', label: '3 oylik', quantity: 3, tab: null, fromPriceTiyin: '16500000' },
    { id: 'sku_12', label: '12 oylik', quantity: 12, tab: null, fromPriceTiyin: null },
  ],
  unitPriceTiyin: null,
};

export const ok = (product: CatalogProductDetail): SiteProductLookup => ({
  status: 'ok',
  product,
});
export const NOT_FOUND: SiteProductLookup = { status: 'not-found' };
export const UNAVAILABLE: SiteProductLookup = { status: 'unavailable' };
