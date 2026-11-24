import { LOCALES } from '@repo/shared';
import type { MetadataRoute } from 'next';
import { pageUrl } from './page-metadata';
import { indexablePages, SITE_PAGES, type SitePage } from './site-pages';

/**
 * One entry per indexable page and language, each listing every language version of the page
 * (`uz`, `ru`, `x-default`) as alternates: Google reads hreflang from the sitemap as well as
 * from the page, and the two must agree. Pure: the registry and the site URL come in as arguments.
 */
export function buildSitemap(
  siteUrl: string,
  pages: readonly SitePage[] = SITE_PAGES,
): MetadataRoute.Sitemap {
  return indexablePages(pages).flatMap((page) => {
    const languages = {
      ...Object.fromEntries(LOCALES.map((locale) => [locale, pageUrl(siteUrl, locale, page.path)])),
      'x-default': pageUrl(siteUrl, 'uz', page.path),
    };
    return LOCALES.map((locale) => ({
      url: pageUrl(siteUrl, locale, page.path),
      lastModified: page.lastModified,
      changeFrequency: page.changeFrequency,
      priority: page.priority,
      alternates: { languages },
    }));
  });
}
