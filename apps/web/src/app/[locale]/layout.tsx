import { BRAND } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { env } from '../../env';
import { AuthSync } from '../../features/auth/AuthSync';
import { ThemeScript } from '../../csp/ThemeScript';
import { MESSAGES } from '../../i18n/messages';
import { routing } from '../../i18n/routing';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';
import { Providers } from '../providers';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: BRAND.name,
};

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

  // Only the namespaces client components read are serialised into the page (not bot.* etc.).
  const { common, errors, web } = MESSAGES[locale];

  return (
    // ThemeProvider writes data-theme / data-reduced on <html> after hydration.
    <html lang={locale} className={FONT_CLASSES} suppressHydrationWarning>
      <head>
        <ThemeScript variant="web" />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={{ common, errors, web }}>
          <ThemeProvider variant="web">
            <Providers>
              <AuthSync />
              {children}
            </Providers>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
