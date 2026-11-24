import type { CatalogProductListItem, Locale } from '@repo/shared';
import { formatTiyinString } from '../../../lib/format/tiyin';
import { SITE_PAGES, type SitePage } from '../seo/site-pages';
import {
  COMING_SOON,
  LAUNCH_PRODUCTS,
  type ComingSoonProduct,
  type ProductNameKey,
} from './coming-soon';

// What the landing's product grid draws, decided in one place from what the catalog API answered
// (docs/04 "Katalog"): live products from the API, "Tez orada" tiles for the games that are not
// there yet, and the degraded forms for an API that cannot be reached or has nothing to sell.
// Nothing here computes money: a price is the server's tiyin string, laid out by `formatMoney`.

export type LandingProductsState =
  /** The API answered with products. */
  | 'ok'
  /** The API could not be used: Stars and Premium without a price, plus "Tez orada". */
  | 'unavailable'
  /** The API answered with an empty catalog: only "Tez orada" and a way into the bot. */
  | 'empty';

export interface LandingTile {
  kind: 'live' | 'soon';
  slug: string;
  /** The API's (localised) name; `null` for a tile the page names itself (`nameKey`). */
  name: string | null;
  nameKey: ProductNameKey | null;
  /** Path without a locale prefix; `null` for a tile that is not a link. */
  path: `/${string}` | null;
  /** The server's tiyin string, or `null` (no fresh price: no price is shown). */
  fromPriceTiyin: string | null;
  regionBadge: string | null;
  featured: boolean;
  /** `auto`: delivered by the system; `code`: a voucher code; `null`: unknown or manual. */
  delivery: 'auto' | 'code' | null;
  inStock: boolean;
  /** Path of the product picture; `null` for a tile without one. */
  imageUrl: string | null;
}

export interface LandingProducts {
  state: LandingProductsState;
  tiles: LandingTile[];
}

/**
 * Where a tile leads: the product's own SEO page when the site has one (it is in the registry),
 * else its page in the store.
 */
export function productPath(slug: string, pages: readonly SitePage[] = SITE_PAGES): `/${string}` {
  return pages.some((page) => page.path === `/${slug}`) ? `/${slug}` : `/store/products/${slug}`;
}

function liveTile(product: CatalogProductListItem, pages: readonly SitePage[]): LandingTile {
  return {
    kind: 'live',
    slug: product.slug,
    name: product.name,
    nameKey: null,
    path: productPath(product.slug, pages),
    fromPriceTiyin: product.fromPriceTiyin,
    regionBadge: product.regionBadge,
    featured: product.isFeatured,
    delivery: product.isAuto ? 'auto' : product.deliveryType === 'VOUCHER' ? 'code' : null,
    inStock: product.inStock,
    imageUrl: product.imageUrl,
  };
}

function launchTile(product: ComingSoonProduct, pages: readonly SitePage[]): LandingTile {
  return {
    kind: 'live',
    slug: product.slug,
    name: null,
    nameKey: product.nameKey,
    path: productPath(product.slug, pages),
    fromPriceTiyin: null,
    regionBadge: null,
    featured: false,
    delivery: null,
    inStock: true,
    imageUrl: null,
  };
}

function soonTile(product: ComingSoonProduct): LandingTile {
  return {
    kind: 'soon',
    slug: product.slug,
    name: null,
    nameKey: product.nameKey,
    path: null,
    fromPriceTiyin: null,
    regionBadge: null,
    featured: false,
    delivery: null,
    inStock: true,
    imageUrl: null,
  };
}

/**
 * @param products the catalog list, or `null` when the API could not be used (see
 *   `getSiteProducts`).
 */
export function buildLandingProducts(
  products: readonly CatalogProductListItem[] | null,
  pages: readonly SitePage[] = SITE_PAGES,
): LandingProducts {
  if (products === null) {
    return {
      state: 'unavailable',
      tiles: [
        ...LAUNCH_PRODUCTS.map((product) => launchTile(product, pages)),
        ...COMING_SOON.map(soonTile),
      ],
    };
  }

  const live = products.map((product) => liveTile(product, pages));
  const served = new Set(products.map((product) => product.slug));
  const soon = COMING_SOON.filter((product) => !served.has(product.slug)).map(soonTile);
  return { state: live.length === 0 ? 'empty' : 'ok', tiles: [...live, ...soon] };
}

/**
 * "11 000" from a tiyin string for a price line; `null` when there is nothing honest to show: no
 * price, a value that is not a tiyin string, or zero (a zero price is a missing price, never "free").
 */
export function landingPriceAmount(tiyin: string | null, locale: Locale): string | null {
  if (tiyin === null || tiyin === '0') return null;
  return formatTiyinString(tiyin, locale);
}
