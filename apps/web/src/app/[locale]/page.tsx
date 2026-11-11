import { BRAND } from '@repo/shared';
import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '../../i18n/routing';

type Props = { params: Promise<{ locale: string }> };

const pathFor = (locale: string) => (locale === routing.defaultLocale ? '/' : `/${locale}`);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return {
    alternates: {
      canonical: pathFor(locale),
      languages: {
        ...Object.fromEntries(routing.locales.map((l) => [l, pathFor(l)])),
        'x-default': pathFor(routing.defaultLocale),
      },
    },
  };
}

// Temporary home (phase 7 scaffold). The landing is built from the design handoff in phase 8.
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('common');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <h1 className="font-display text-4xl font-bold text-foreground">{BRAND.name}</h1>
      <p className="text-base text-foreground-secondary">{t('comingSoon')}</p>
    </main>
  );
}
