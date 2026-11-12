import { BRAND } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ThemeScript } from '../../csp/ThemeScript';
import { AuthSync } from '../../features/auth/AuthSync';
import { env } from '../../env';
import { TITLE_TEMPLATE } from '../../features/site/seo/page-metadata';
import { ROOT_NAMESPACES } from '../../i18n/namespaces';
import { pickMessages } from '../../i18n/pick-messages';
import { routing } from '../../i18n/routing';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: { default: BRAND.name, template: TITLE_TEMPLATE },
  applicationName: BRAND.name,
  // A phone number in a text is not a link to dial: the pages are about top-ups, not contacts.
  formatDetection: { telephone: false },
};

// The root of every page with a locale, kept light on purpose: the landing pages must not pay for
// the store. It holds the document, the fonts, the theme, and the texts of `common` (the 404 and
// the small client islands). The store and the sign-in page add their own providers in their
// layouts (AppClientShell).
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

  return (
    // ThemeProvider writes data-theme / data-reduced on <html> after hydration.
    <html lang={locale} className={FONT_CLASSES} suppressHydrationWarning>
      <head>
        <ThemeScript variant="web" />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={pickMessages(locale, ROOT_NAMESPACES)}>
          <ThemeProvider variant="web">
            {/* Cheap: the cross-tab handler is only loaded when another tab signs in or out. */}
            <AuthSync />
            {children}
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
