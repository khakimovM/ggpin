import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ContactsPage } from '../../../../features/site/contacts/ContactsPage';
import { pageMetadata } from '../../../../features/site/seo/page-metadata';
import { routing } from '../../../../i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'site.meta.contacts' });
  return pageMetadata({
    locale,
    path: '/contacts',
    title: t('title'),
    description: t('description'),
  });
}

/** The contacts page (phase 8 S4): support, the bot, the channel and the hours; no company details. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <ContactsPage locale={locale} />;
}
