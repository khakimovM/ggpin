import { BRAND } from '@repo/shared';
import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requestNonce } from '../../../csp/request-nonce';
import { env } from '../../../env';
import { FaqSection } from '../../../features/site/landing/FaqSection';
import { FinalCta } from '../../../features/site/landing/FinalCta';
import { Hero } from '../../../features/site/landing/Hero';
import { HowItWorks } from '../../../features/site/landing/HowItWorks';
import { ProductsSection } from '../../../features/site/landing/ProductsSection';
import { WhyUs } from '../../../features/site/landing/WhyUs';
import { JsonLd } from '../../../features/site/seo/JsonLd';
import { organizationLd, websiteLd } from '../../../features/site/seo/json-ld';
import { pageMetadata, pageUrl } from '../../../features/site/seo/page-metadata';
import { siteLinks } from '../../../features/site/shell/site-links';
import { routing } from '../../../i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'site.meta.home' });
  return pageMetadata({
    locale,
    path: '/',
    // The title names the brand itself ("ggpin — ..."), so the layout's template is not added.
    title: t('title', { brand: BRAND.name }),
    titleAbsolute: true,
    description: t('description'),
  });
}

/**
 * The landing (Site.dc.html `page: landing`, hero `classic`): hero, products, how it works, why
 * us, FAQ, final call to action. A server component all the way: the only client code on the page
 * is the site header's menu and the product pictures. The referral band of the design is left out
 * until the referral percentage is decided (phase 10). The FAQ block has no `FAQPage` JSON-LD:
 * that lives only on `/faq`, which asks all these questions and more (one page per question set).
 */
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const nonce = await requestNonce();
  const { bot, channel } = siteLinks();

  return (
    <main>
      <JsonLd
        nonce={nonce}
        data={organizationLd({
          name: BRAND.name,
          url: pageUrl(env.NEXT_PUBLIC_SITE_URL, 'uz', '/'),
          sameAs: [bot, channel].filter((link): link is string => link !== null),
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
      <Hero locale={locale} />
      <ProductsSection locale={locale} />
      <HowItWorks locale={locale} />
      <WhyUs locale={locale} />
      <FaqSection locale={locale} />
      <FinalCta locale={locale} />
    </main>
  );
}
