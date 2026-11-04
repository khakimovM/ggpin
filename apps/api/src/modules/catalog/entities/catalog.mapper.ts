import {
  ProductInputSchema,
  type CatalogCategory,
  type CatalogLocaleQuery,
  type CatalogProductDetail,
  type CatalogProductListItem,
  type CatalogSku,
} from '@repo/shared';
import type { ProductDisplayPrices } from '../../pricing/price-book.types';
import { customQtyRange } from '../../pricing/pricing-sku';
import type { CatalogProductRow, CategoryWithCount } from '../catalog.repository';

type Locale = CatalogLocaleQuery['locale'];
type SkuRow = CatalogProductRow['skus'][number];

// The only place catalog rows become the public shape. Fields are listed one by one (no spread)
// so a new column (supplierSku, markupBps, minMarginTiyin, routes) can never reach the wire.
// Brand names are stored identically in both languages, so choosing a column is all it takes.
function pick<T extends string | null>(locale: Locale, uz: T, ru: T): T {
  return locale === 'ru' ? ru : uz;
}

function money(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

export function toCategory(row: CategoryWithCount, locale: Locale): CatalogCategory {
  return {
    slug: row.slug,
    name: pick(locale, row.nameUz, row.nameRu),
    productCount: row.activeProductCount,
  };
}

export function toListItem(
  row: CatalogProductRow,
  locale: Locale,
  prices: ProductDisplayPrices | undefined,
  inStock: boolean,
): CatalogProductListItem {
  return {
    id: row.id,
    slug: row.slug,
    categorySlug: row.category.slug,
    name: pick(locale, row.nameUz, row.nameRu),
    imageUrl: row.imageUrl,
    regionBadge: row.regionBadge,
    deliveryType: row.deliveryType,
    isAuto: row.isAuto,
    isFeatured: row.isFeatured,
    inStock,
    fromPriceTiyin: money(prices?.fromPriceTiyin),
  };
}

function toSku(sku: SkuRow, locale: Locale, prices: ProductDisplayPrices | undefined): CatalogSku {
  return {
    id: sku.id,
    label: pick(locale, sku.labelUz, sku.labelRu),
    quantity: sku.quantity,
    tab: sku.tab,
    fromPriceTiyin: money(prices?.skuPriceTiyin.get(sku.id)),
  };
}

export function toDetail(
  row: CatalogProductRow,
  locale: Locale,
  prices: ProductDisplayPrices | undefined,
  stock: number | null,
): CatalogProductDetail {
  // Not the raw columns: the range a quote accepts also depends on the active packs.
  const customQty = customQtyRange(row, row.skus);
  return {
    id: row.id,
    slug: row.slug,
    name: pick(locale, row.nameUz, row.nameRu),
    description: pick(locale, row.descriptionUz, row.descriptionRu),
    help: pick(locale, row.helpUz, row.helpRu),
    imageUrl: row.imageUrl,
    deliveryType: row.deliveryType,
    regionBadge: row.regionBadge,
    isAuto: row.isAuto,
    allowCustomQty: customQty !== null,
    minQty: customQty?.min ?? null,
    maxQty: customQty?.max ?? null,
    // Parsed, not cast: a malformed stored form is a data bug that must surface, not reach a client.
    inputSchema: ProductInputSchema.parse(row.inputSchema),
    skus: row.skus.map((sku) => toSku(sku, locale, prices)),
    unitPriceTiyin: money(prices?.unitPriceTiyin),
    stock,
    currency: 'UZS',
  };
}
