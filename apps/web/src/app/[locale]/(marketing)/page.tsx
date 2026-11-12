import { BRAND } from '@repo/shared';
import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requestNonce } from '../../../csp/request-nonce';
import { env } from '../../../env';
import { JsonLd } from '../../../features/site/seo/JsonLd';
import { organizationLd, websiteLd } from '../../../features/site/seo/json-ld';
import { pageMetadata, pageUrl } from '../../../features/site/seo/page-metadata';
import { routing } from '../../../i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  // The brand alone is the title until the landing's own texts arrive (phase 8 S2).
  return pageMetadata({ locale, path: '/', title: BRAND.name, titleAbsolute: true });
}

// Temporary home (phase 7 scaffold). The landing is built from the design handoff in phase 8.
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('common');
  const nonce = await requestNonce();
  const channel = env.NEXT_PUBLIC_TELEGRAM_CHANNEL_URL;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <JsonLd
        nonce={nonce}
        data={organizationLd({
          name: BRAND.name,
          url: pageUrl(env.NEXT_PUBLIC_SITE_URL, 'uz', '/'),
          sameAs: [
            `https://t.me/${env.NEXT_PUBLIC_BOT_USERNAME}`,
            ...(channel === '' ? [] : [channel]),
          ],
        })}
      />
      <JsonLd
        nonce={nonce}
        data={websiteLd({
          name: BRAND.name,
          url: pageUrl(env.NEXT_PUBLIC_SITE_URL, locale, '/'),
          inLanguage: locale,
        })}
      />
      <h1 className="font-display text-4xl font-bold text-foreground">{BRAND.name}</h1>
      <p className="text-base text-foreground-secondary">{t('comingSoon')}</p>
    </main>
  );
}
