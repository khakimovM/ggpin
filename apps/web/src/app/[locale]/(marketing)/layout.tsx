import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteAnalytics } from '../../../features/site/analytics/SiteAnalytics';
import { SiteFooter } from '../../../features/site/shell/SiteFooter';
import { SiteHeader } from '../../../features/site/shell/SiteHeader';
import { routing } from '../../../i18n/routing';

// The marketing pages (landing, product pages, FAQ, legal, contacts): the site header above, the
// footer below, the page between them. The only place the analytics script is rendered (phase 8
// S5): the store, the login, the Mini App and the payment page never load it.
export default async function MarketingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'site.nav' });

  return (
    // A column at least as tall as the window: a short page (the error page) still leaves the footer
    // at the bottom edge, not floating under the content.
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-primary focus:px-4 focus:py-3 focus:text-sm focus:font-bold focus:text-primary-foreground"
      >
        {t('skip')}
      </a>
      <SiteHeader locale={locale} />
      {/* The target of the skip link; focusable so that the next Tab starts inside the page. */}
      <div id="main-content" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </div>
      <SiteFooter locale={locale} />
      <SiteAnalytics />
    </div>
  );
}
