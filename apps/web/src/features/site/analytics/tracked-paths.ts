// Not `routing` (it imports the @repo/shared barrel at runtime, and with it secret NAMES the
// landing chunk does not need: p8 S6 audit L-2): the client copy of the locales.
import { DEFAULT_LOCALE_CLIENT, LOCALES_CLIENT } from '../../../i18n/client-locales';
import { SITE_PAGES } from '../seo/site-pages';

// The marketing pages, the only ones analytics may know about (phase 8 S5). Used twice: the beacon
// filter drops every other path (as the page and as the referrer), and zones.ts tells the marketing
// zone from the rest, so a link between the zones is a full page load and the tracker stays put.

/** The URL prefix of every locale but the default one (`as-needed`: uz has none). */
const PREFIXES = LOCALES_CLIENT.filter((locale) => locale !== DEFAULT_LOCALE_CLIENT).map(
  (locale) => `/${locale}`,
);

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
