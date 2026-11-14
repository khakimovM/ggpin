import type { Locale } from '@repo/shared';
import { MESSAGES } from './messages';
import { ROOT_NAMESPACES } from './namespaces';
import { pickMessages } from './pick-messages';

/**
 * What the root layout hands to the browser: `common`, plus the three texts of the error page
 * (`site.error`). `error.tsx` is a client component that only sees this provider, and the rest of
 * `site.*` (the landing's marketing copy, rendered on the server) must not travel with it.
 */
export function rootMessages(locale: Locale) {
  return {
    ...pickMessages(locale, ROOT_NAMESPACES),
    site: { error: MESSAGES[locale].site.error },
  };
}
