import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { StoreHome } from '../../../../features/store/StoreHome';
import { routing } from '../../../../i18n/routing';

// Placeholder until the catalog (phase 7 S5): it gives the sign-in somewhere to land.
export default async function StorePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <StoreHome />;
}
