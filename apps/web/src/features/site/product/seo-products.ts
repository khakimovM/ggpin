import type { ProductNameKey } from '../landing/coming-soon';

// The products that have a page of their own for search (phase 8 S3): one registry entry, one
// folder under `app/[locale]/(marketing)/<slug>/page.tsx`, the texts under `site.product.<contentKey>`,
// and an entry in the site registry (`site-pages.ts`). A game added later is the same four steps.
//
// Why the folders are explicit and not one `[product]` segment: a dynamic segment would compete
// with the `[...rest]` 404 catch-all and answer 200 for any word.

/** What the small cards under the picture can say; the page draws those it has data for. */
export type FactKind = 'unitPrice' | 'min' | 'plans' | 'delivery' | 'recipient';

export type SeoGlyph = 'star' | 'crown';

export interface SeoProduct {
  /** The catalog slug, which is also the page's path. */
  slug: string;
  path: `/${string}`;
  /** Key of `site.product.<contentKey>`: the page's own copy. */
  contentKey: 'stars' | 'premium';
  /** Key of `site.products.names`: the product's name (a brand, not translated). */
  nameKey: ProductNameKey;
  /** The picture of the design is not there yet: the page draws this glyph on the product's tint. */
  glyph: SeoGlyph;
  /** The cards under the picture, in order. */
  facts: readonly FactKind[];
  /**
   * How many packages the catalog usually lists for the product: as many as the seed creates
   * (packages/db/prisma/seed/catalog-data.ts: 6 Stars packs, 3 Premium plans) and the e2e catalog
   * lists. Only the placeholder of the list uses it, to take the list's room while the catalog is
   * read. Kept by hand: once the admin adds or removes packages, the placeholder no longer matches
   * the list and the page moves again when the answer arrives (layout shift), until this follows.
   */
  packages: number;
  /** How many questions `site.product.<contentKey>.faq.items` holds (q1..qN). */
  faqCount: number;
  /**
   * The product is delivered by the system (CLAUDE.md section 1). It decides what the page may say
   * when the catalog cannot be read; with an answer, the API's `isAuto` decides.
   */
  autoDelivery: boolean;
}

export const SEO_PRODUCTS = [
  {
    slug: 'telegram-stars',
    path: '/telegram-stars',
    contentKey: 'stars',
    nameKey: 'stars',
    glyph: 'star',
    facts: ['unitPrice', 'min', 'delivery'],
    packages: 6,
    faqCount: 4,
    autoDelivery: true,
  },
  {
    slug: 'telegram-premium',
    path: '/telegram-premium',
    contentKey: 'premium',
    nameKey: 'premium',
    glyph: 'crown',
    facts: ['plans', 'delivery', 'recipient'],
    packages: 3,
    faqCount: 4,
    autoDelivery: true,
  },
] as const satisfies readonly SeoProduct[];

export type SeoProductSlug = (typeof SEO_PRODUCTS)[number]['slug'];

export function seoProduct(slug: SeoProductSlug): SeoProduct {
  const found: SeoProduct | undefined = SEO_PRODUCTS.find((product) => product.slug === slug);
  if (found === undefined) throw new Error(`no SEO product ${slug}`);
  return found;
}

/** How many "other products" the page shows at the foot (the design shows four). */
export const RELATED_LIMIT = 4;
