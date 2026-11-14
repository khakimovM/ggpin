'use client';

import { BRAND } from '@repo/shared';
import { HIT_AREA_LINK } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { localizedPath } from '../../i18n/paths';
import { DISPLAY_TIME_ZONE } from '../../lib/format/date';
import { PrivateLink } from '../../lib/PrivateLink';

// The year in Uzbekistan time, like every other date of the app (and the same on server and client).
const yearNow = () =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: DISPLAY_TIME_ZONE }).format(
    new Date(),
  );

const LINKS = [
  { path: '/terms', key: 'terms' },
  { path: '/privacy', key: 'privacy' },
  { path: '/contacts', key: 'contact' },
] as const;

/**
 * Store.dc.html footer: the copyright, and the offer, the privacy policy and the contacts, which
 * are pages of the site (phase 8 S4) in the store's language. They are marketing pages, so the
 * links load them anew (PrivateLink): the site's analytics never enters the store's document.
 */
export function StoreFooter() {
  const t = useTranslations('web.footer');
  const locale = useLocale();
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1264px] flex-wrap items-center justify-between gap-3 px-4 py-5 text-[13px] leading-[18px] font-semibold text-foreground-muted md:px-6 lg:px-8">
        <span>{t('copyright', { year: yearNow(), brand: BRAND.name })}</span>
        {/* On a touch screen a link's pressable area is 44 px: wrapped rows keep apart by the rest. */}
        <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-[max(8px,calc(var(--hit-min,24px)-18px))] p-0">
          {LINKS.map((link) => (
            <li key={link.key} className="flex">
              <PrivateLink
                href={localizedPath(locale, link.path)}
                prefetch={false}
                className={`relative text-foreground-secondary no-underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring ${HIT_AREA_LINK}`}
              >
                {t(link.key)}
              </PrivateLink>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
