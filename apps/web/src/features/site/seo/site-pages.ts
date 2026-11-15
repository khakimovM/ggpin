// The one list of the website's public pages. The sitemap, the Lighthouse URL list and the SEO
// tests all read it, so a page exists for search engines exactly when it is written here.
//
// A slice that adds a page adds its entry in the same change: the sitemap must never list a URL
// that answers 404. Pages the crawler should not index (the store, the login, the Mini App, the
// payment page) are NOT listed at all; they carry `noindex` themselves.
//
// No runtime import here: the Lighthouse script runs this file with Node's type stripping.

export type SiteChangeFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** What a page is: the tests that own a kind of page find their pages by it. */
export type SitePageKind = 'home' | 'product' | 'faq' | 'contacts' | 'legal';

export interface SitePage {
  /** Path without a locale prefix: `/` or `/telegram-stars`. */
  path: `/${string}`;
  kind: SitePageKind;
  /**
   * `false` for a page that exists but is not ready for search (a legal text that is still a
   * draft): it renders with `noindex` and stays out of the sitemap.
   */
  indexable: boolean;
  /** ISO date (YYYY-MM-DD) of the last content change; bumped by hand with the content. */
  lastModified: string;
  changeFrequency: SiteChangeFrequency;
  /** 0..1, a hint to crawlers about the page's weight inside this site. */
  priority: number;
}

export const SITE_PAGES: readonly SitePage[] = [
  // The landing (phase 8 S2).
  {
    path: '/',
    kind: 'home',
    indexable: true,
    lastModified: '2026-11-12',
    changeFrequency: 'weekly',
    priority: 1,
  },
  // The product pages (phase 8 S3). One entry per product of `product/seo-products.ts`: a test
  // keeps the two lists in step.
  {
    path: '/telegram-stars',
    kind: 'product',
    indexable: true,
    lastModified: '2026-11-12',
    changeFrequency: 'weekly',
    priority: 0.9,
  },
  {
    path: '/telegram-premium',
    kind: 'product',
    indexable: true,
    lastModified: '2026-11-12',
    changeFrequency: 'weekly',
    priority: 0.9,
  },
  // The information pages (phase 8 S4).
  {
    path: '/faq',
    kind: 'faq',
    indexable: true,
    lastModified: '2026-11-13',
    changeFrequency: 'monthly',
    priority: 0.6,
  },
  {
    path: '/contacts',
    kind: 'contacts',
    indexable: true,
    lastModified: '2026-11-13',
    changeFrequency: 'monthly',
    priority: 0.5,
  },
  // The legal texts. `indexable` is the opposite of the document's `draft` flag in
  // `legal/legal-docs.ts` (this file imports nothing, so a test keeps the two in step): a draft is
  // not indexed and not in the sitemap. The lawyer's text turns both (D-16, D-57).
  {
    path: '/terms',
    kind: 'legal',
    indexable: false,
    lastModified: '2026-11-13',
    changeFrequency: 'yearly',
    priority: 0.3,
  },
  {
    path: '/privacy',
    kind: 'legal',
    indexable: false,
    lastModified: '2026-11-13',
    changeFrequency: 'yearly',
    priority: 0.3,
  },
];

export function indexablePages(pages: readonly SitePage[] = SITE_PAGES): SitePage[] {
  return pages.filter((page) => page.indexable);
}
