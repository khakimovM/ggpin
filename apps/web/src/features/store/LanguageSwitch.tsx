'use client';

import { SegmentedControl, cn } from '@repo/ui';
import { LOCALES, type Locale } from '@repo/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useChangeLocale } from '../account/use-change-locale';

/**
 * The language switch of the store header. For a signed-in user it saves the choice first
 * (`PATCH /me`) and then reloads the page in the new language; if the server refuses, the language
 * stays and a short message appears under the switch (see useChangeLocale).
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useTranslations('web.nav');
  const error = useTranslations('account.profile.language')('error');
  const locale = useLocale();
  const { change, busy, failed } = useChangeLocale('web');
  const names: Record<Locale, string> = { uz: t('langUz'), ru: t('langRu') };
  return (
    <span
      aria-busy={busy}
      className={cn(
        'relative transition-opacity duration-fast',
        busy && 'cursor-progress opacity-60',
        className,
      )}
    >
      <SegmentedControl
        variant="neutral"
        size="sm"
        ariaLabel={t('language')}
        value={locale}
        options={LOCALES.map((code) => ({
          value: code,
          label: code.toUpperCase(),
          ariaLabel: names[code],
        }))}
        onValueChange={change}
      />
      {failed ? (
        <span
          role="alert"
          className="absolute top-full right-0 z-50 mt-1.5 w-max max-w-[260px] rounded-xl bg-danger-soft px-3 py-2 text-xs leading-4 font-bold text-danger-text shadow-md"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
