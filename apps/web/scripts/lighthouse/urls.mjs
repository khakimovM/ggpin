// The URLs the Lighthouse run measures. They come straight from the site's page registry
// (src/features/site/seo/site-pages.ts), the same list the sitemap reads, so a page added there
// is measured here without touching this file. Node runs the TypeScript registry directly
// (type stripping); the registry has no runtime imports, which keeps that possible.
import { SITE_PAGES } from '../../src/features/site/seo/site-pages.ts';

import { SITE_ORIGIN } from './servers.mjs';

/** Uzbek is the default locale and has no prefix; Russian lives under /ru. */
const LOCALES = [
  { locale: 'uz', prefix: '' },
  { locale: 'ru', prefix: '/ru' },
];

function localizedPath(prefix, path) {
  if (path === '/') return prefix === '' ? '/' : prefix;
  return `${prefix}${path}`;
}

/** One entry per page and locale: { url, path, locale, indexable }. */
export function lighthouseTargets(pages = SITE_PAGES) {
  return pages.flatMap((page) =>
    LOCALES.map(({ locale, prefix }) => {
      const path = localizedPath(prefix, page.path);
      return { url: `${SITE_ORIGIN}${path}`, path, locale, indexable: page.indexable };
    }),
  );
}
