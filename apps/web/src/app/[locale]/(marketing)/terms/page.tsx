import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { LegalPage } from '../../../../features/site/legal/LegalPage';
import { legalDoc } from '../../../../features/site/legal/legal-docs';
import { legalMetadata } from '../../../../features/site/legal/legal-metadata';
import { routing } from '../../../../i18n/routing';

type Props = { params: Promise<{ locale: string }> };

const DOC = legalDoc('terms');

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  return legalMetadata(locale, DOC);
}

/** The public offer (phase 8 S4): a draft until the lawyer's text is in (D-16), see legal-docs.ts. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <LegalPage locale={locale} doc={DOC} />;
}
