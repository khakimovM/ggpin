'use client';

import { NextIntlClientProvider } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import type { Messages } from '../i18n/messages';
import { useTgUiStore } from '../stores/tg-ui-store';

// Uzbekistan has one time zone; without one next-intl warns that server and client may differ.
const TIME_ZONE = 'Asia/Tashkent';

/** The namespaces the Mini App screens read; both languages travel to the client. */
export type TgMessages = Pick<
  Messages,
  'common' | 'errors' | 'fields' | 'tg' | 'store' | 'wallet' | 'account'
>;
export interface TgCatalogs {
  uz: TgMessages;
  ru: TgMessages;
}

/**
 * The Mini App has no locale in its URL. Its language is a client state: Telegram's language_code
 * at first, the profile's locale after sign-in (see useTgSession). Both catalogs are loaded so
 * switching never waits for the network.
 */
export function TgIntlProvider({
  catalogs,
  children,
}: {
  catalogs: TgCatalogs;
  children: ReactNode;
}) {
  const locale = useTgUiStore((state) => state.locale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]} timeZone={TIME_ZONE}>
      {children}
    </NextIntlClientProvider>
  );
}
