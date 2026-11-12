// The one list of the website's public pages. The sitemap, the Lighthouse URL list and the SEO
// tests all read it, so a page exists for search engines exactly when it is written here.
//
// A slice that adds a page adds its entry in the same change: the sitemap must never list a URL
// that answers 404. Pages the crawler should not index (the store, the login, the Mini App, the
// payment page) are NOT listed at all; they carry `noindex` themselves.

export type SiteChangeFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface SitePage {
  /** Path without a locale prefix: `/` or `/telegram-stars`. */
  path: `/${string}`;
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
  // Temporary home of phase 7; the landing (phase 8 S2) replaces its content.
  {
    path: '/',
    indexable: true,
    lastModified: '2026-11-11',
    changeFrequency: 'weekly',
    priority: 1,
  },
];

export function indexablePages(pages: readonly SitePage[] = SITE_PAGES): SitePage[] {
  return pages.filter((page) => page.indexable);
}
