'use client';

import type { Locale } from '@repo/shared';
import { cn, HIT_AREA_44 } from '@repo/ui';
import { useLocale } from 'next-intl';
import { usePathname } from 'next/navigation';
import { LOCALES_CLIENT } from '../../../i18n/client-locales';
import { stripLocale } from '../../../i18n/locale-path';
import { localizedPath } from '../../../i18n/paths';
import { LINK_FOCUS } from './nav-config';

export interface LangSwitchLabels {
  /** Name of the group: "Til". */
  group: string;
  /** Full name of each language; read after the visible code ("UZ — O‘zbekcha"): the accessible name must contain the visible text (WCAG 2.5.3). */
  names: Record<Locale, string>;
}

/**
 * The language switch of the site (Site.dc.html: two-segment pill, UZ / RU). Plain links to the
 * same page in the other language, so it works without script, search engines follow it, and a
 * language is a URL you can share. A full page load, not a client navigation: the document's
 * `lang`, the fonts and the texts are all new, and a fresh document is the simplest way to get
 * every one of them right.
 */
export function SiteLangSwitch({
  labels,
  size = 'bar',
  className,
}: {
  labels: LangSwitchLabels;
  /** bar: the header and footer (34 px segments); menu: the mobile menu (38 px). */
  size?: 'bar' | 'menu';
  className?: string;
}) {
  const locale = useLocale();
  const path = stripLocale(usePathname());
  return (
    <div
      role="group"
      aria-label={labels.group}
      className={cn('inline-flex gap-0.5 rounded-full bg-muted p-[3px]', className)}
    >
      {LOCALES_CLIENT.map((code) => {
        const current = code === locale;
        return (
          <a
            key={code}
            href={localizedPath(code, path)}
            hrefLang={code}
            lang={code}
            aria-current={current ? 'true' : undefined}
            aria-label={`${code.toUpperCase()} — ${labels.names[code]}`}
            className={cn(
              'relative inline-flex items-center justify-center rounded-full font-extrabold no-underline',
              size === 'bar'
                ? 'h-[34px] min-w-11 px-2.5 text-xs'
                : 'h-[38px] min-w-12 px-2.5 text-[13px]',
              current
                ? 'bg-card text-foreground shadow-sm'
                : 'text-foreground-muted hover:text-foreground',
              HIT_AREA_44,
              LINK_FOCUS,
            )}
          >
            {code.toUpperCase()}
          </a>
        );
      })}
    </div>
  );
}
