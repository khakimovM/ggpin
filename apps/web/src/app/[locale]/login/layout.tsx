import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { LOGIN_NAMESPACES } from '../../../i18n/namespaces';
import { routing } from '../../../i18n/routing';
import { AppClientShell } from '../../AppClientShell';

// The sign-in page talks to the API (the TanStack Query client, the cross-tab listener), which the
// light root layout does not provide.
export default async function LoginLayout({
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
    <AppClientShell locale={locale} namespaces={LOGIN_NAMESPACES}>
      {children}
    </AppClientShell>
  );
}
