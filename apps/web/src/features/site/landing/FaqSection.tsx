import type { Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import { MessageCircle } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { FaqAccordion } from '../faq/FaqAccordion';
import { LINK_FOCUS } from '../shell/nav-config';
import { siteLinks } from '../shell/site-links';
import { getLandingFaq } from './faq-items';
import {
  LANDING_ANCHOR,
  LANDING_CONTAINER,
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
      <div
        className={cn(
          LANDING_CONTAINER,
          'grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-x-16 gap-y-8',
        )}
      >
        <div className="flex flex-col gap-3">
          <h2 id="faq-title" className={LANDING_H2}>
            {t('title')}
          </h2>
          <p className={LANDING_LEAD}>{t('lead')}</p>
          {support === null ? null : (
            <a
              href={support}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'flex min-h-11 items-center gap-2 self-start rounded-control border-[1.5px] border-border px-4 py-2 text-sm leading-none font-bold text-foreground no-underline hover:bg-muted hover:text-foreground',
                LINK_FOCUS,
              )}
            >
              <Icon icon={MessageCircle} size={16} />
              {t('support')}
            </a>
          )}
        </div>
        <FaqAccordion items={items} />
      </div>
    </section>
  );
}
