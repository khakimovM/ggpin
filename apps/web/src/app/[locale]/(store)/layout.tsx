import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthGuard } from '../../../features/auth/AuthGuard';
import { STORE_NAMESPACES } from '../../../i18n/namespaces';
import { routing } from '../../../i18n/routing';
import { AppClientShell } from '../../AppClientShell';

// The store is private to a signed-in user and has nothing for a crawler. The Next server cannot
// see the cookie session (the API sets it for its own host), so the gate is a client one.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function StoreLayout({
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
    <AppClientShell locale={locale} namespaces={STORE_NAMESPACES}>
      <AuthGuard>{children}</AuthGuard>
    </AppClientShell>
  );
}
