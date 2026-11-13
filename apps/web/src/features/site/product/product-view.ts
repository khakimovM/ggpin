import type { SiteProductLookup } from '../catalog-server';
import type { FactKind, SeoProduct } from './seo-products';

// What a product page draws, decided in one place from what the catalog answered (docs/04
// "Katalog") and from the page's own registry entry. Nothing here computes money: a price is the
// server's tiyin string (or null), laid out later by `formatMoney`.

export type ProductPageState =
  /** The catalog answered with the product and its packages. */
  | 'ok'
  /** The product exists but has no packages: say what is known (the minimum) and lead to the store. */
  | 'no-packages'
  /** The catalog could not be used: no price, no package list, the way to the store stays. */
  | 'unavailable'
  /** The catalog says the product does not exist (any more): "Hozircha mavjud emas", no way to buy. */
  | 'not-found';

export interface ProductPackage {
  id: string;
  /** The API's label ("500 ⭐", "3 oylik"); shown as it is. */
  label: string;
  /** The server's tiyin string; `null` when there is no fresh price (nothing is shown). */
  priceTiyin: string | null;
}

export interface ProductView {
  state: ProductPageState;
  /** Delivered by the system: the API's `isAuto`, or the registry's answer when there is none. */
  auto: boolean;
  regionBadge: string | null;
  packages: ProductPackage[];
  /** Display only ("1 star is about X"); never multiplied here. */
  unitPriceTiyin: string | null;
  minQty: number | null;
  /** The buyer may type any amount between the limits (Stars), so the page can say so. */
  customQty: boolean;
}

// A zero price is a missing price, never "free" (same rule as the landing's tiles).
const priceOrNull = (tiyin: string | null): string | null =>
  tiyin === null || tiyin === '0' ? null : tiyin;

export function buildProductView(lookup: SiteProductLookup, seo: SeoProduct): ProductView {
  if (lookup.status === 'not-found') {
    return {
      state: 'not-found',
      auto: false,
      regionBadge: null,
      packages: [],
      unitPriceTiyin: null,
      minQty: null,
      customQty: false,
    };
  }
  if (lookup.status === 'unavailable') {
    return {
      state: 'unavailable',
      auto: seo.autoDelivery,
      regionBadge: null,
      packages: [],
      unitPriceTiyin: null,
      minQty: null,
      customQty: false,
    };
  }

  const { product } = lookup;
  const packages = product.skus.map((sku): ProductPackage => ({
    id: sku.id,
    label: sku.label,
    priceTiyin: priceOrNull(sku.fromPriceTiyin),
  }));
  return {
    state: packages.length === 0 ? 'no-packages' : 'ok',
    auto: product.isAuto,
    regionBadge: product.regionBadge,
    packages,
    unitPriceTiyin: priceOrNull(product.unitPriceTiyin),
    minQty: product.minQty,
    customQty: product.allowCustomQty && product.minQty !== null,
  };
}

export type ProductFact =
  | { kind: 'unitPrice'; tiyin: string }
  | { kind: 'min'; quantity: number }
  | { kind: 'plans'; count: number }
  | { kind: 'delivery' }
  | { kind: 'recipient' };

function factOf(kind: FactKind, view: ProductView): ProductFact | null {
  switch (kind) {
    case 'unitPrice':
      return view.unitPriceTiyin === null ? null : { kind, tiyin: view.unitPriceTiyin };
    case 'min':
      return view.minQty === null ? null : { kind, quantity: view.minQty };
    case 'plans':
      return view.packages.length === 0 ? null : { kind, count: view.packages.length };
    case 'delivery':
      return view.auto ? { kind } : null;
    case 'recipient':
      return { kind };
  }
}

/**
 * The cards under the picture: those the registry lists for the product and the data supports (a
 * card with nothing to say is left out, never filled in). A product the catalog does not know has
 * none.
 */
export function productFacts(view: ProductView, seo: SeoProduct): ProductFact[] {
  if (view.state === 'not-found') return [];
  return seo.facts.flatMap((kind) => {
    const fact = factOf(kind, view);
    return fact === null ? [] : [fact];
  });
}
