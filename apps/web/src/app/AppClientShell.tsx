import type { Locale } from '@repo/shared';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import type { Messages } from '../i18n/messages';
import { pickMessages } from '../i18n/pick-messages';
import { Providers } from './providers';

/**
 * The client-side machinery of the pages that talk to the API as a signed-in visitor (the store and
 * the sign-in page): the texts of the namespaces they read and the TanStack Query client. The marketing pages do not get any
 * of it, so a landing visit does not load the query client or ship the store's texts.
 */
export function AppClientShell({
  locale,
  namespaces,
  children,
}: {
  locale: Locale;
  namespaces: readonly (keyof Messages)[];
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={pickMessages(locale, namespaces)}>
      <Providers>{children}</Providers>
    </NextIntlClientProvider>
  );
}
