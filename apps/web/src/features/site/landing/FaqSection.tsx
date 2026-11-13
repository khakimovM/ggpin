import type { Locale } from '@repo/shared';
import { cn } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { FaqAccordion } from '../faq/FaqAccordion';
import { FaqSupportLink } from '../faq/FaqSupportLink';
import { siteLinks } from '../shell/site-links';
import { getLandingFaq } from './faq-items';
import {
  LANDING_ANCHOR,
  LANDING_CONTAINER,
  LANDING_FAQ_GRID,
  LANDING_H2,
  LANDING_LEAD,
  LANDING_SECTION_Y,
} from './landing-styles';

/**
 * Site.dc.html `#savollar`: the heading with the way to ask, and the accordion (the first answer
 * open). With no support link configured the "write to support" button is left out.
 */
export async function FaqSection({ locale }: { locale: Locale }) {
  const [t, items] = await Promise.all([
    getTranslations({ locale, namespace: 'site.faq' }),
    getLandingFaq(locale),
  ]);
  const { support } = siteLinks();

  return (
    <section
      id="faq"
      aria-labelledby="faq-title"
      className={cn(LANDING_ANCHOR, LANDING_SECTION_Y, 'border-y border-border bg-surface')}
    >
      <div className={cn(LANDING_CONTAINER, LANDING_FAQ_GRID)}>
        <div className="flex flex-col gap-3">
          <h2 id="faq-title" className={LANDING_H2}>
            {t('title')}
          </h2>
          <p className={LANDING_LEAD}>{t('lead')}</p>
          {support === null ? null : <FaqSupportLink href={support} label={t('support')} />}
        </div>
        <FaqAccordion items={items} />
      </div>
    </section>
  );
}
