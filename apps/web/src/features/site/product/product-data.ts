import { type Locale } from '@repo/shared';
import { cache } from 'react';
import { lookupSiteProduct, type SiteProductLookup } from '../catalog-server';

/**
 * The catalog answer for one product, read once per page render. The page has more than one
 * block that needs it (the cards, the badges, the package list), each inside its own <Suspense>;
 * `cache` makes them share one request instead of racing three (the data cache of Next.js only
 * helps once the first answer has arrived).
 */
export const loadProduct: (slug: string, locale: Locale) => Promise<SiteProductLookup> = cache(
  (slug: string, locale: Locale) => lookupSiteProduct(slug, locale),
);
