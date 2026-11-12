import { BRAND, type Locale } from '@repo/shared';
import { cn, Icon, Logo } from '@repo/ui';
import { Send } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { storePath } from '../../../i18n/paths';
import { siteLinks } from '../shell/site-links';
import { LANDING_CONTAINER, LANDING_CTA_PRIMARY, LANDING_CTA_SECONDARY } from './landing-styles';

/** Site.dc.html last section: the mark, one sentence, and the two ways in (the bot, the store). */
export async function FinalCta({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site.cta' });
  const { bot } = siteLinks();

  return (
    <section aria-labelledby="cta-title" className="py-[clamp(56px,7vw,112px)]">
      <div className={cn(LANDING_CONTAINER, 'flex flex-col items-center gap-5 text-center')}>
        <Logo name={BRAND.name} size={64} decorative className="shadow-glow" />
        <h2
          id="cta-title"
          className="m-0 max-w-[760px] font-display text-[clamp(24px,2.8vw,40px)] leading-[1.18] font-bold tracking-[-.03em] text-balance"
        >
          {t('title')}
        </h2>
        <p className="m-0 max-w-[520px] text-base leading-6 font-medium text-foreground-secondary">
          {t('lead')}
        </p>
        <div className="mt-1 flex w-full flex-wrap justify-center gap-3">
          {bot === null ? null : (
            <a
              href={bot}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(LANDING_CTA_PRIMARY, 'flex-[0_1_260px]')}
            >
              <Icon icon={Send} size={18} />
              {t('telegram')}
            </a>
          )}
          <Link
            href={storePath(locale)}
            prefetch={false}
            className={cn(LANDING_CTA_SECONDARY, 'flex-[0_1_260px]')}
          >
            {t('store')}
          </Link>
        </div>
      </div>
    </section>
  );
}
