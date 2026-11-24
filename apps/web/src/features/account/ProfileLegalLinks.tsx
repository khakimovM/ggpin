'use client';

import { cn, HIT_AREA_LINK } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { MouseEvent } from 'react';
import { localizedPath } from '../../i18n/paths';
import { openSitePage, resolveSitePageUrl } from '../../telegram/open-link';

const DOCS = [
  { key: 'terms', path: '/terms' },
  { key: 'privacy', path: '/privacy' },
] as const;

const LINK = cn(
  'relative text-[13px] leading-[18px] font-bold text-foreground-secondary no-underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  HIT_AREA_LINK,
);

/**
 * A legal page from the Mini App. The site's pages refuse to be framed, so a tap hands the page to
 * Telegram's browser (`openSitePage`, exact paths only). The href is the same checked URL: if the
 * client refuses the call, the tap is left to the link itself.
 */
function MiniAppSiteLink({ path, label }: { path: string; label: string }) {
  const href = resolveSitePageUrl(path);
  if (href === null) return null;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (openSitePage(path)) event.preventDefault();
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={open} className={LINK}>
      {label}
    </a>
  );
}

/**
 * The foot of the Mini App profile (Account.dc.html): the offer and the privacy policy, centred,
 * opened outside the Mini App. The web profile has none (Store.dc.html): the store footer carries
 * them there. The design's version line under them is not drawn (no version to show yet).
 */
export function ProfileLegalLinks() {
  const t = useTranslations('account.profile.legal');
  const locale = useLocale();
  return (
    <footer className="flex flex-col items-center pt-2 pb-1">
      {/* On a touch screen a link's pressable area is 44 px: wrapped rows keep apart by the rest. */}
      <ul className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-[max(8px,calc(var(--hit-min,24px)-18px))] p-0">
        {DOCS.map((doc) => {
          const path = localizedPath(locale, doc.path);
          return (
            <li key={doc.key} className="flex">
              <MiniAppSiteLink path={path} label={t(doc.key)} />
            </li>
          );
        })}
      </ul>
    </footer>
  );
}
