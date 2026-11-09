'use client';

import { BRAND, LOCALES } from '@repo/shared';
import { Logo, SegmentedControl } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';

/**
 * The page header (PayPage.dc.html): the mark and the language switch. The language lives in the
 * `?locale=` query (D-38), so switching it is a soft navigation to the same path with the other
 * value; the fragment is long gone by then and is never put back.
 */
export function PayHeader() {
  const t = useTranslations('pay');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-border bg-surface px-[max(16px,calc((100%-560px)/2))] lg:px-[max(16px,calc((100%-1040px)/2))]">
      <Logo variant="wordmark" size={19} name={BRAND.name} />
      <SegmentedControl
        variant="neutral"
        size="sm"
        ariaLabel={t('lang')}
        value={locale}
        options={LOCALES.map((code) => ({ value: code, label: code.toUpperCase() }))}
        onValueChange={(next) => router.replace(`${pathname}?locale=${next}`, { scroll: false })}
      />
    </header>
  );
}
