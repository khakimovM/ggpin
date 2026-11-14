// The products the landing announces as "Tez orada" (phase 8 plan P8-Q4, D-02 order): no price, no
// link, only the brand's name. A product leaves this list by itself the moment the API serves it
// (its slug is then a live tile).
//
// `nameKey` is a key of `site.products.names`: brand names are not translated, but they live with
// the other texts and not in the components.

export type ProductNameKey = 'stars' | 'premium' | 'pubg' | 'mlbb' | 'steam' | 'roblox';

export interface ComingSoonProduct {
  slug: string;
  nameKey: ProductNameKey;
}

export const COMING_SOON: readonly ComingSoonProduct[] = [
  { slug: 'pubg-mobile', nameKey: 'pubg' },
  { slug: 'mobile-legends', nameKey: 'mlbb' },
  { slug: 'steam', nameKey: 'steam' },
  { slug: 'roblox', nameKey: 'roblox' },
];

/**
 * The two products that exist from the first day (CLAUDE.md section 1). They are what the
 * landing still shows, without a price, when the catalog API cannot be reached.
 */
export const LAUNCH_PRODUCTS: readonly ComingSoonProduct[] = [
  { slug: 'telegram-stars', nameKey: 'stars' },
  { slug: 'telegram-premium', nameKey: 'premium' },
];
