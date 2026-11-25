// Which Fragment product a catalog product is (phase 6, owner Q4 = A): decided by the product's
// slug, which the admin panel does not change, so no schema column is needed. Anything else is
// `null`: an adapter that sells only Stars and Premium must not guess, and a real one never pays
// for a product it cannot name (fail closed; the dry-run simulator documents its own fallback).

/** The catalog slugs of the two Fragment products (packages/db seed `catalog-data.ts`). */
export const FRAGMENT_PRODUCT_SLUGS = {
  STARS: 'telegram-stars',
  PREMIUM: 'telegram-premium',
} as const;

export type FragmentProductKind = keyof typeof FRAGMENT_PRODUCT_SLUGS;

/** The kind of a product by its exact slug; null for any other slug (no prefix, no case folding). */
export function fragmentProductKind(slug: string): FragmentProductKind | null {
  if (slug === FRAGMENT_PRODUCT_SLUGS.STARS) return 'STARS';
  if (slug === FRAGMENT_PRODUCT_SLUGS.PREMIUM) return 'PREMIUM';
  return null;
}

/** The only Telegram Premium terms sold, in months (owner Q4); a SKU of any other length is not. */
export const PREMIUM_MONTHS = [3, 6, 12] as const;
export type PremiumMonths = (typeof PREMIUM_MONTHS)[number];

export function isPremiumMonths(months: number): months is PremiumMonths {
  return (PREMIUM_MONTHS as readonly number[]).includes(months);
}
