import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { FaqPage } from '../../../../features/site/faq/FaqPage';
import { pageMetadata } from '../../../../features/site/seo/page-metadata';
import { routing } from '../../../../i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'site.meta.faq' });
  return pageMetadata({ locale, path: '/faq', title: t('title'), description: t('description') });
}

/** The FAQ page (phase 8 S4): the landing's and the help screen's questions, each once. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <FaqPage locale={locale} />;
}
