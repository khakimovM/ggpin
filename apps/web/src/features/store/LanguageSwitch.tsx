'use client';

import { SegmentedControl } from '@repo/ui';
import { LOCALES, type Locale } from '@repo/shared';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { switchLocalePath } from '../../i18n/locale-path';

/** The language switch: two segments that are links, so the page is reloaded in the new language. */
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useTranslations('web.nav');
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const names: Record<Locale, string> = { uz: t('langUz'), ru: t('langRu') };
  return (
    <SegmentedControl
      variant="neutral"
      size="sm"
      ariaLabel={t('language')}
      className={className}
      value={locale}
      options={LOCALES.map((code) => ({
        value: code,
        label: code.toUpperCase(),
        ariaLabel: names[code],
      }))}
      onValueChange={(next) => {
        // A full navigation: the catalogs of the other language are loaded with the page.
        window.location.assign(switchLocalePath(pathname, search === '' ? '' : `?${search}`, next));
      }}
    />
  );
}
