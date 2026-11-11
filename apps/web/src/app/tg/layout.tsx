import { BRAND } from '@repo/shared';
import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { requestNonce } from '../../csp/request-nonce';
import { ThemeScript } from '../../csp/ThemeScript';
import { env } from '../../env';
import { MESSAGES, type Messages } from '../../i18n/messages';
import type { TgMessages } from '../../telegram/TgIntlProvider';
import { TgRoot } from '../../telegram/TgRoot';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: BRAND.name,
  // The Mini App is an app shell, not a page for search engines.
  robots: { index: false, follow: false },
};

// viewport-fit=cover lets the Telegram safe-area insets be applied in CSS.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

const TELEGRAM_SDK = 'https://telegram.org/js/telegram-web-app.js';

// Only the namespaces the Mini App screens read travel to the client, in both languages: the
// language is chosen on the client (Telegram's language_code, then the profile's locale).
const pick = ({ common, errors, fields, tg, store, wallet, account }: Messages): TgMessages => ({
  common,
  errors,
  fields,
  tg,
  store,
  wallet,
  account,
});
const CATALOGS = {
  uz: pick(MESSAGES.uz),
  ru: pick(MESSAGES.ru),
};

// This is a root layout of its own (the Mini App has no locale prefix). `lang` starts as the
// default locale; TgIntlProvider updates it once the language is known.
export default async function TelegramLayout({ children }: { children: ReactNode }) {
  const nonce = await requestNonce();
  return (
    <html lang="uz" data-surface="tg" className={FONT_CLASSES} suppressHydrationWarning>
      <head>
        <ThemeScript variant="tg" />
        {/* Loaded by Next before hydration, so window.Telegram exists when the provider reads it.
            Carries the request's nonce; the CSP also names telegram.org for older browsers. */}
        <Script src={TELEGRAM_SDK} strategy="beforeInteractive" nonce={nonce} />
      </head>
      <body>
        <TgRoot catalogs={CATALOGS}>{children}</TgRoot>
      </body>
    </html>
  );
}
