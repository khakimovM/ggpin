import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ProductSeoPage } from '../../../../features/site/product/ProductSeoPage';
import { productMetadata } from '../../../../features/site/product/product-metadata';
import { seoProduct } from '../../../../features/site/product/seo-products';
import { routing } from '../../../../i18n/routing';

type Props = { params: Promise<{ locale: string }> };

const SEO = seoProduct('telegram-stars');

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  return productMetadata(locale, SEO);
}

/** The product page of Telegram Stars (phase 8 S3); the template is shared, see ProductSeoPage. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <ProductSeoPage locale={locale} seo={SEO} />;
}
