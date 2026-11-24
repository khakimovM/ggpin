import { BRAND, DEFAULT_LOCALE, LOCALES, type Locale } from '@repo/shared';
import type { Metadata } from 'next';
import { env } from '../../../env';
import { localizedPath } from '../../../i18n/paths';

// Metadata of a marketing page, built in one place so that every page gets the same canonical,
// hreflang and Open Graph rules. The URLs are absolute: crawlers and link previews do not resolve
// a relative one reliably, and `x-default` must be a full URL.
//
// RULE: `generateMetadata` never goes to the network or to the API: metadata is built from i18n and
// static data only. `htmlLimitedBots` (next.config.ts) puts the metadata into <head> for every
// client, so the first byte of every page waits for it; a fetch here would hold up all visitors'
// TTFB. A unit test (metadata-no-network.test.ts) reads the pages' sources to keep it so.

export const TITLE_SEPARATOR = ' — ';

/** The `title.template` of the locale layout: "<page title> — ggpin". */
export const TITLE_TEMPLATE = `%s${TITLE_SEPARATOR}${BRAND.name}`;

const OG_LOCALE: Record<Locale, string> = { uz: 'uz_UZ', ru: 'ru_RU' };

export interface PageMetadataInput {
  locale: Locale;
  /** Path without a locale prefix. Anything after `?` or `#` is dropped (see canonicalPath). */
  path: `/${string}`;
  title: string;
  /** The title already names the brand: do not add the layout's " — ggpin". */
  titleAbsolute?: boolean;
  description?: string;
  /** Path (`/og/stars.png`) or full URL of the share image; no image tag when absent. */
  ogImage?: string;
  /** A page that exists but must not be indexed (a draft legal text). */
  noindex?: boolean;
}

/**
 * The path of a page as its canonical URL spells it: no query (a `?utm_source=` copy is the same
 * page), no fragment, no trailing slash except for the root.
 */
export function canonicalPath(path: string): `/${string}` {
  const bare = (path.split(/[?#]/, 1)[0] ?? '').replace(/\/+$/, '');
  return bare === '' ? '/' : bare.startsWith('/') ? (bare as `/${string}`) : `/${bare}`;
}

/**
 * Full URL of a page in a locale. The default locale has no prefix, so its home is `<site>` (no slash: Next.js writes the root URL that way in the head, and the sitemap and hreflang must say the same) and
 * the Russian one `<site>/ru` (what the server answers with 200; `/ru/` redirects to it).
 */
export function pageUrl(siteUrl: string, locale: Locale, path: string): string {
  const local = localizedPath(locale, canonicalPath(path));
  return local === '/' ? siteUrl : `${siteUrl}${local}`;
}

export function pageMetadata(
  input: PageMetadataInput,
  siteUrl: string = env.NEXT_PUBLIC_SITE_URL,
): Metadata {
  const { locale, title, titleAbsolute = false, description, ogImage, noindex = false } = input;
  const absolute = (loc: Locale) => pageUrl(siteUrl, loc, input.path);
  const url = absolute(locale);
  const ogTitle = titleAbsolute ? title : `${title}${TITLE_SEPARATOR}${BRAND.name}`;
  const image = ogImage === undefined ? undefined : new URL(ogImage, `${siteUrl}/`).toString();

  return {
    title: titleAbsolute ? { absolute: title } : title,
    ...(description === undefined ? {} : { description }),
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(LOCALES.map((loc) => [loc, absolute(loc)])),
        'x-default': absolute(DEFAULT_LOCALE),
      },
    },
    openGraph: {
      type: 'website',
      siteName: BRAND.name,
      title: ogTitle,
      ...(description === undefined ? {} : { description }),
      url,
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((loc) => loc !== locale).map((loc) => OG_LOCALE[loc]),
      ...(image === undefined ? {} : { images: [{ url: image }] }),
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      ...(description === undefined ? {} : { description }),
      ...(image === undefined ? {} : { images: [image] }),
    },
  };
}
