import { DEFAULT_LOCALE, LOCALES } from '@repo/shared';
import { defineRouting } from 'next-intl/routing';

// uz is the default and has no URL prefix (`/`), ru lives under `/ru`. The language is chosen by
// the URL (and later the profile), never by Accept-Language: docs/08 makes uz the default.
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeDetection: false,
});
