import { BRAND } from '@repo/shared';
import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { env } from '../../env';
import { MESSAGES } from '../../i18n/messages';
import { routing } from '../../i18n/routing';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';
import { Providers } from '../providers';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: BRAND.name,
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

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
  const { common, errors } = MESSAGES[locale];

  return (
    <html lang={locale} className={FONT_CLASSES}>
      <body>
        <NextIntlClientProvider locale={locale} messages={{ common, errors }}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
