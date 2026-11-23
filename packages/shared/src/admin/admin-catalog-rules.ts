// Domain rules of the admin catalog writes (docs/04 "Admin" — Katalog; plan p9 S8a, owner Q5/Q6).
// The API checks them under the Product row lock; the panel uses the same codes to name the field.
//
// TEMPORARY (9-A): the Premium months and the product slug are local constants because the
// phase 5 helpers (`PREMIUM_MONTHS`, `fragmentProductKind`) are not on `main` yet. In 9-B, once
// phase 5 is merged, replace `ADMIN_PREMIUM_MONTHS` / `isPremiumProductSlug` with the phase 5
// exports and keep an equality test between them (plan p9-s7-s9 §6.1).

/** Field codes a catalog write may put in `details.fields[].code` (docs/04 «Xatolar (admin)»). */
export const ADMIN_CATALOG_FIELD_ERROR_CODES = Object.freeze([
  /** path `quantity`: a free-quantity product already has an active package of this quantity. */
  'DUPLICATE_PACKAGE',
  /** path `quantity`: a Telegram Premium package is not 3, 6 or 12 months. */
  'PREMIUM_MONTHS',
  /** path `productIds`: the reorder list is not every product exactly once (a repeat too). */
  'PRODUCT_SET_MISMATCH',
  /** path `quantity`: a free-quantity product's package is outside its `minQty..maxQty`. */
  'QUANTITY_RANGE',
] as const);
export type AdminCatalogFieldErrorCode = (typeof ADMIN_CATALOG_FIELD_ERROR_CODES)[number];

/**
 * Upper bound of a package's minimum margin: 10 000 000 000 tiyin = 100 mln so‘m (owner decision
 * 2026-11-22). A typo of a few zeros would otherwise price the package out of the store.
 */
export const ADMIN_MAX_MIN_MARGIN_TIYIN = 10_000_000_000n;

/** The free-quantity range of a product (`Product.minQty` / `maxQty`). */
export interface ProductQuantityRange {
  readonly allowCustomQty: boolean;
  readonly minQty: number | null;
  readonly maxQty: number | null;
}

/**
 * True when a package of `quantity` fits the product: inside `minQty..maxQty` (both ends
 * included) on a free-quantity product. A product without both bounds sells no typed quantity
 * at all (the API's `customQtyRange` returns null), so its packages are plain fixed packs and
 * any quantity fits, as on a fixed-pack product.
 */
export function packageQuantityInRange(product: ProductQuantityRange, quantity: number): boolean {
  const { allowCustomQty, minQty, maxQty } = product;
  if (!allowCustomQty || minQty === null || maxQty === null) return true;
  return quantity >= minQty && quantity <= maxQty;
}

/** Months a Telegram Premium gift can be bought for (Fragment). Replaced in 9-B, see above. */
export const ADMIN_PREMIUM_MONTHS: readonly number[] = Object.freeze([3, 6, 12]);

/** The seeded Telegram Premium product (packages/db seed `catalog-data.ts`). */
export const PREMIUM_PRODUCT_SLUG = 'telegram-premium';

export function isPremiumProductSlug(slug: string): boolean {
  return slug === PREMIUM_PRODUCT_SLUG;
}

/** True when a package of `quantity` is allowed on the product with this slug. */
export function premiumMonthsAllowed(slug: string, quantity: number): boolean {
  return !isPremiumProductSlug(slug) || ADMIN_PREMIUM_MONTHS.includes(quantity);
}

/**
 * True when `given` is exactly the set `all`: same size, no repeat, nothing missing or foreign.
 * The order of `given` is the new order; the order of `all` does not matter.
 */
export function isFullProductSet(all: readonly string[], given: readonly string[]): boolean {
  if (all.length !== given.length) return false;
  const known = new Set(all);
  const seen = new Set<string>();
  for (const id of given) {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return seen.size === known.size;
}
