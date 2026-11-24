import type { Locale } from '@repo/shared';
import { cn } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { requestNonce } from '../../../csp/request-nonce';
import { env } from '../../../env';
import { localizedPath } from '../../../i18n/paths';
import {
  LANDING_CONTAINER,
  LANDING_FAQ_GRID,
  LANDING_H2,
  LANDING_LEAD,
} from '../landing/landing-styles';
import { Breadcrumbs } from '../product/Breadcrumbs';
import { JsonLd } from '../seo/JsonLd';
import { breadcrumbLd, faqLd } from '../seo/json-ld';
import { pageUrl } from '../seo/page-metadata';
import { siteLinks } from '../shell/site-links';
import { FaqAccordion } from './FaqAccordion';
import { FaqSupportLink } from './FaqSupportLink';
import { getFaqPageItems } from './faq-page';

/**
 * The FAQ page (`/faq`). It has no design of its own (P8-Q9): it is the landing's FAQ block
 * (Site.dc.html `#savollar`) as a page, under the product pages' trail, with every question of
 * the landing and of the help screen asked once (faq-page.ts). The same questions go to search
 * engines as `FAQPage`. A server component; the accordion needs no JavaScript.
 */
export async function FaqPage({ locale }: { locale: Locale }) {
  const [crumbs, meta, faq, infoLinks, items, nonce] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common.breadcrumb' }),
    getTranslations({ locale, namespace: 'site.meta.faq' }),
    getTranslations({ locale, namespace: 'site.faq' }),
    getTranslations({ locale, namespace: 'site.footer.infoLinks' }),
    getFaqPageItems(locale),
    requestNonce(),
  ]);
  const { support } = siteLinks();
  const title = meta('title');
  const site = env.NEXT_PUBLIC_SITE_URL;

  return (
    <main>
      <JsonLd
        nonce={nonce}
        data={breadcrumbLd([
          { name: crumbs('home'), url: pageUrl(site, locale, '/') },
          { name: title, url: pageUrl(site, locale, '/faq') },
        ])}
      />
      <JsonLd nonce={nonce} data={faqLd(items)} />
      <Breadcrumbs
        label={crumbs('label')}
        items={[
          { label: crumbs('home'), href: localizedPath(locale, '/') },
          { label: title, href: null },
        ]}
      />
      <div
        className={cn(
          LANDING_CONTAINER,
          LANDING_FAQ_GRID,
          'pt-[clamp(20px,3vw,40px)] pb-[clamp(48px,6vw,96px)]',
        )}
      >
        <div className="flex flex-col gap-3">
          <h1 className={LANDING_H2}>{title}</h1>
          <p className={LANDING_LEAD}>{faq('lead')}</p>
          {/* The lead asks to write to us: with no support chat configured, the contacts page (the
              bot, the channel, the hours) is where to go instead of no way at all. */}
          {support === null ? (
            <FaqSupportLink
              href={localizedPath(locale, '/contacts')}
              label={infoLinks('contacts')}
              internal
            />
          ) : (
            <FaqSupportLink href={support} label={faq('support')} />
          )}
        </div>
        <FaqAccordion items={items} group="faq-page" questionLevel={2} />
      </div>
    </main>
  );
}
