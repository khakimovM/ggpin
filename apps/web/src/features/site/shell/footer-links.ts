import { SITE_PAGES, type SitePage } from '../seo/site-pages';

// The links the footer would like to show. A link is drawn only when its page is in the site
// registry (`SITE_PAGES`), so the footer never points at a page that does not exist yet: the
// slice that adds a page adds its registry entry and the link appears by itself.

export const FOOTER_PRODUCT_LINKS = [
  { path: '/telegram-stars', labelKey: 'stars' },
  { path: '/telegram-premium', labelKey: 'premium' },
] as const;

export const FOOTER_INFO_LINKS = [
  { path: '/faq', labelKey: 'faq' },
  { path: '/terms', labelKey: 'terms' },
  { path: '/privacy', labelKey: 'privacy' },
  { path: '/contacts', labelKey: 'contacts' },
] as const;

/** The wanted links whose page exists. */
export function linksToExistingPages<T extends { path: `/${string}` }>(
  wanted: readonly T[],
  pages: readonly SitePage[] = SITE_PAGES,
): T[] {
  const existing = new Set(pages.map((page) => page.path));
  return wanted.filter((link) => existing.has(link.path));
}
