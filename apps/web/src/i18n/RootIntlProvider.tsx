'use client';

import { NextIntlClientProvider } from 'next-intl';
import type { ComponentProps } from 'react';
import { DISPLAY_TIME_ZONE } from '../lib/format/date';

/**
 * The root layout's translation provider, as a client module of its own. The store and the sign-in
 * page use `NextIntlClientProvider` directly (AppClientShell); when the root layout used it too,
 * Next.js listed that one module under the store layout's chunk group, and a landing visit loaded
 * the store's chunks (the Zod bundle, the query client; ~100 KB gzipped) before it needed any of
 * them. With a module that only the root layout imports, the landing loads the root's chunks.
 *
 * Limit: the request config (i18n/request.ts) sets no `timeZone`, `now` or `formats`. This provider
 * passes only the time zone; `now` and `formats` are NOT passed. A client island of the root that
 * needs named `formats` or a fixed `now` must get them added here.
 */
export function RootIntlProvider(props: ComponentProps<typeof NextIntlClientProvider>) {
  // The time zone is explicit: without it a client island would format a date in the visitor's own
  // zone while the server renders in its own, and the two texts would differ at hydration.
  return <NextIntlClientProvider timeZone={DISPLAY_TIME_ZONE} {...props} />;
}
