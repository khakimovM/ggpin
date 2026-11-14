import { routing } from '../../../i18n/routing';
import { SITE_PAGES } from '../seo/site-pages';

// The marketing pages, the only ones analytics may know about (phase 8 S5). Used twice: the beacon
// filter drops every other path (as the page and as the referrer), and zones.ts tells the marketing
// zone from the rest, so a link between the zones is a full page load and the tracker stays put.

/** The URL prefix of every locale but the default one (`as-needed`: uz has none). */
const PREFIXES = routing.locales
  .filter((locale) => locale !== routing.defaultLocale)
  .map((locale) => `/${locale}`);

/** Every path of a marketing page, in each locale: `/`, `/faq`, `/ru`, `/ru/faq`, ... */
const TRACKED_PATHS: ReadonlySet<string> = new Set(
  SITE_PAGES.flatMap(({ path }) => [
    path,
    ...PREFIXES.map((prefix) => (path === '/' ? prefix : `${prefix}${path}`)),
  ]),
);

/** True only for the exact path of a marketing page (no trailing slash, no query, no hash). */
export function isTrackedPath(pathname: string): boolean {
  return TRACKED_PATHS.has(pathname);
}
