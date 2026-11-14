// Data of the fixture catalog server (catalog-server.ts): the list comes from the shared Playwright
// fixture (e2e/fixtures/catalog.ts), the details are built here. Runs under plain Node (type
// stripping), so relative imports spell the `.ts` extension and nothing here needs a bundler.
import {
  CatalogCategorySchema,
  CatalogProductDetailSchema,
  CatalogProductListItemSchema,
  type CatalogCategory,
  type CatalogProductDetail,
  type CatalogProductListItem,
} from '@repo/shared';
import { CATEGORIES, PRODUCTS } from '../fixtures/catalog.ts';

export type FixtureLocale = 'uz' | 'ru';

/** Tiyin per star: 220 so'm (the figure the other fakes use). */
const STAR_TIYIN = 22_000;
const STAR_PACKS = [50, 100, 250, 500, 1000, 2500];
const PREMIUM_PRICE: Record<number, string> = { 3: '16500000', 6: '22000000', 12: '39600000' };
const MONTHS: Record<FixtureLocale, (months: number) => string> = {
  uz: (months) => `${months} oylik`,
  ru: (months) => `${months} мес.`,
};

export const categories = (locale: FixtureLocale): CatalogCategory[] =>
  CATEGORIES.map((category) => ({
    slug: category.slug,
    name: category.name[locale],
    productCount: PRODUCTS.filter((product) => product.categorySlug === category.slug).length,
  }));

// The seed pictures (/assets/products/*.svg) are not files of a build, so a browser would report each
// one as a 404 in its console. The fixture sends a value that is not a local path: the site draws the
// empty picture slot of the design and makes no request.
const NO_PICTURE = 'fixture-no-picture';

// The list's "from" price is the cheapest package of the detail, as the real API's is, so a tile and
// the product page it leads to never disagree. Stars is priced by the star here; Premium's cheapest
// is its 3-month plan, which the shared list fixture already carries.
const STARS_FROM_TIYIN = String(Math.min(...STAR_PACKS) * STAR_TIYIN);

export const productList = (): CatalogProductListItem[] =>
  PRODUCTS.map((item) => ({
    ...item,
    imageUrl: NO_PICTURE,
    fromPriceTiyin: item.slug === 'telegram-stars' ? STARS_FROM_TIYIN : item.fromPriceTiyin,
  }));

export function productDetail(slug: string, locale: FixtureLocale): CatalogProductDetail | null {
  const item = PRODUCTS.find((product) => product.slug === slug);
  if (item === undefined) return null;
  const common = {
    id: item.id,
    slug: item.slug,
    name: item.name,
    imageUrl: NO_PICTURE,
    deliveryType: item.deliveryType,
    regionBadge: item.regionBadge,
    isAuto: item.isAuto,
    currency: 'UZS' as const,
    help: null,
    inputSchema:
      item.deliveryType === 'TG_USERNAME'
        ? [{ key: 'username', type: 'tgUsername' as const, label: 'fields.tgUsername' }]
        : [],
  };
  if (slug === 'telegram-stars') {
    return {
      ...common,
      description: locale === 'uz' ? 'Fixture: Stars tavsifi' : 'Fixture: описание Stars',
      allowCustomQty: true,
      minQty: 50,
      maxQty: 100_000,
      skus: STAR_PACKS.map((quantity) => ({
        id: `sku_stars_${quantity}`,
        label: `${quantity} ⭐`,
        quantity,
        tab: null,
        fromPriceTiyin: String(quantity * STAR_TIYIN),
      })),
      unitPriceTiyin: String(STAR_TIYIN),
      stock: null,
    };
  }
  if (slug === 'telegram-premium') {
    return {
      ...common,
      description: locale === 'uz' ? 'Fixture: Premium tavsifi' : 'Fixture: описание Premium',
      allowCustomQty: false,
      minQty: null,
      maxQty: null,
      skus: [3, 6, 12].map((months) => ({
        id: `sku_premium_${months}`,
        label: MONTHS[locale](months),
        quantity: months,
        tab: null,
        fromPriceTiyin: PREMIUM_PRICE[months] ?? null,
      })),
      unitPriceTiyin: null,
      stock: null,
    };
  }
  return {
    ...common,
    description: null,
    allowCustomQty: false,
    minQty: null,
    maxQty: null,
    skus: [],
    unitPriceTiyin: null,
    stock: item.inStock ? null : 0,
  };
}

/**
 * Runs every fixture through the shared schemas the site reads them with. A fixture that the real
 * contract would refuse must stop the server at start-up, not show up as a strange page later.
 */
export function assertFixturesMatchContract(): void {
  for (const locale of ['uz', 'ru'] as const) {
    CatalogCategorySchema.array().parse(categories(locale));
    for (const product of PRODUCTS) {
      const detail = productDetail(product.slug, locale);
      if (detail === null) throw new Error(`no detail for ${product.slug}`);
      CatalogProductDetailSchema.parse(detail);
    }
  }
  CatalogProductListItemSchema.array().parse(productList());
}
