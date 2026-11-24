import { BRAND } from '@repo/shared';
import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { LoginFlow } from '../../../features/auth/LoginFlow';
import { localizedPath } from '../../../i18n/paths';
import { routing } from '../../../i18n/routing';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
};

// `?next=` is read per request. A statically generated page would be served with the `next` of
// the build (none) and sign everybody in to the store, whatever they were opening.
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'web.login' });
  return {
    // Already names the brand: not run through the layout's "<title> — ggpin" template.
    title: { absolute: t('title', { brand: BRAND.name }) },
    description: t('subtitle'),
    // A sign-in screen is not a landing page: nothing to index, and `?next=` variants would
    // otherwise be crawled as separate pages.
    robots: { index: false, follow: false },
    alternates: {
      canonical: localizedPath(locale, '/login'),
      languages: Object.fromEntries(routing.locales.map((l) => [l, localizedPath(l, '/login')])),
    },
  };
}

export default async function LoginPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const { next } = await searchParams;
  // Only a single string is a candidate; `?next=a&next=b` is treated as no `next` at all.
  return <LoginFlow next={typeof next === 'string' ? next : null} />;
}
