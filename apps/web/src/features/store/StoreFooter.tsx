'use client';

import { BRAND } from '@repo/shared';
import { HIT_AREA_LINK } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { env } from '../../env';
import { DISPLAY_TIME_ZONE } from '../../lib/format/date';
import { supportLink } from '../../telegram/support-link';

// The year in Uzbekistan time, like every other date of the app (and the same on server and client).
const yearNow = () =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: DISPLAY_TIME_ZONE }).format(
    new Date(),
  );

/**
 * Store.dc.html footer: the copyright and the way to reach us. The design also lists the offer
 * and privacy pages; they are built in phase 8 (landing and legal pages), and a link to a page
 * that does not exist yet is not drawn. The contact leads to the support chat, or to our bot.
 */
export function StoreFooter() {
  const t = useTranslations('web.footer');
  const configured = supportLink(env.NEXT_PUBLIC_SUPPORT_URL);
  const contact =
    configured.kind === 'none'
      ? supportLink(`https://t.me/${env.NEXT_PUBLIC_BOT_USERNAME}`)
      : configured;
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1264px] flex-wrap items-center justify-between gap-3 px-4 py-5 text-[13px] leading-[18px] font-semibold text-foreground-muted md:px-6 lg:px-8">
        <span>{t('copyright', { year: yearNow(), brand: BRAND.name })}</span>
        {contact.kind === 'none' ? null : (
          <a
            href={contact.href}
            target="_blank"
            rel="noopener noreferrer"
            className={`relative text-foreground-secondary no-underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring ${HIT_AREA_LINK}`}
          >
            {t('contact')}
          </a>
        )}
      </div>
    </footer>
  );
}
