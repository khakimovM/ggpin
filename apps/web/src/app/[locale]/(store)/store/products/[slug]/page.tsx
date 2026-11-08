import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ProductScreen } from '../../../../../../features/product/ProductScreen';
import { routing } from '../../../../../../i18n/routing';

export default async function StoreProductPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <ProductScreen variant="web" slug={slug} />;
}
