import { BRAND } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { preload } from 'react-dom';
import type { ReactNode } from 'react';
import { ThemeScript } from '../../csp/ThemeScript';
import { AuthSync } from '../../features/auth/AuthSync';
import { env } from '../../env';
import { TITLE_TEMPLATE } from '../../features/site/seo/page-metadata';
import { RootIntlProvider } from '../../i18n/RootIntlProvider';
import { rootMessages } from '../../i18n/root-messages';
import { routing } from '../../i18n/routing';
import { fontPreloadHref, type FontScript } from '../font-preload';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: { default: BRAND.name, template: TITLE_TEMPLATE },
  applicationName: BRAND.name,
  // A phone number in a text is not a link to dial: the pages are about top-ups, not contacts.
  formatDetection: { telephone: false },
};

// The scripts of each locale's headlines: their Unbounded files are preloaded. Russian headlines
// carry Latin brand names too (Telegram Stars, Premium): with the Cyrillic file alone the Latin one
// arrived later and shifted the RU hero on mobile (Lighthouse CLS 0.018).
const LOCALE_SCRIPTS: Record<(typeof routing.locales)[number], readonly FontScript[]> = {
  uz: ['latin'],
  ru: ['cyrillic', 'latin'],
};

// The root of every page with a locale, kept light on purpose: the landing pages must not pay for
// the store. It holds the document, the fonts, the theme, and the texts of `common` (the 404 and
// the small client islands) and `site.error` (the error page). The store and the sign-in page add
// their own providers in their layouts (AppClientShell).
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // Hoisted by React into <head>; without a build (dev, tests) there is no preload.
  for (const script of LOCALE_SCRIPTS[locale]) {
    const fontHref = fontPreloadHref('Unbounded', script);
    if (fontHref !== null) {
      preload(fontHref, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
    }
  }

  return (
    // ThemeProvider writes data-theme / data-reduced on <html> after hydration.
    <html lang={locale} className={FONT_CLASSES} suppressHydrationWarning>
      <head>
        <ThemeScript variant="web" />
      </head>
      <body>
        <RootIntlProvider locale={locale} messages={rootMessages(locale)}>
          <ThemeProvider variant="web">
            {/* Cheap: the cross-tab handler is only loaded when another tab signs in or out. */}
            <AuthSync />
            {children}
          </ThemeProvider>
        </RootIntlProvider>
      </body>
    </html>
  );
}
