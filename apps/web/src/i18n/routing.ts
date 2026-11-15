import { DEFAULT_LOCALE, LOCALES } from '@repo/shared';
import { defineRouting } from 'next-intl/routing';

// uz is the default and has no URL prefix (`/`), ru lives under `/ru`. The language is chosen by
// the URL (and later the profile), never by Accept-Language: docs/08 makes uz the default.
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeDetection: false,
  // next-intl's own `Link: rel=alternate` response header is built from the request's Host and
  // X-Forwarded-Host, which a client controls (p8 S6 audit L-1). The pages already carry their
  // hreflang links in the HTML and the sitemap, both built from NEXT_PUBLIC_SITE_URL.
  alternateLinks: false,
});
