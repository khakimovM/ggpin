import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { HistoryScreen } from '../../../../../features/account/HistoryScreen';
import { routing } from '../../../../../i18n/routing';

// The web order history. The sign-in gate is the layout above; the shell adds the store header.
export default async function OrdersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <HistoryScreen variant="web" />;
}
