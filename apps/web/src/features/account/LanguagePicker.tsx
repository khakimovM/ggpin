'use client';

import { cn } from '@repo/ui';
import { LOCALES, type Locale } from '@repo/shared';
import { useLocale, useTranslations } from 'next-intl';
import type { KeyboardEvent } from 'react';
import { useChangeLocale } from './use-change-locale';

/**
 * The language switch of the profile (Account.dc.html `langs`): two pills. The choice is saved
 * with `PATCH /me` first and only then applied (see useChangeLocale); a failure keeps the old
 * language and says so. A radio group: arrow keys move and select. While a change runs the pills
 * are `aria-disabled`, not `disabled`: a disabled button would drop the keyboard focus.
 */
export function LanguagePicker({ variant }: { variant: 'tg' | 'web' }) {
  const t = useTranslations('account.profile.language');
  const current = useLocale();
  const { change, busy, failed } = useChangeLocale(variant);
  const names: Record<Locale, string> = { uz: t('uz'), ru: t('ru') };

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = LOCALES[(index + step + LOCALES.length) % LOCALES.length];
    if (next === undefined) return;
    change(next);
    document.getElementById(`lang-${next}`)?.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={t('label')}
        aria-busy={busy}
        className="flex gap-1 rounded-full bg-muted p-1"
      >
        {LOCALES.map((locale, index) => {
          const selected = locale === current;
          return (
            <button
              key={locale}
              id={`lang-${locale}`}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={busy}
              tabIndex={selected ? 0 : -1}
              onClick={() => change(locale)}
              onKeyDown={(event) => onKey(event, index)}
              className={cn(
                'h-11 flex-1 cursor-pointer rounded-full border-none text-[15px] leading-none font-extrabold transition-colors duration-base ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-wait',
                selected
                  ? 'bg-card text-foreground shadow-sm'
                  : 'bg-transparent text-foreground-muted hover:text-foreground',
              )}
            >
              {names[locale]}
            </button>
          );
        })}
      </div>
      {failed ? (
        <p role="alert" className="m-0 px-1 text-[13px] leading-[18px] font-bold text-danger-text">
          {t('error')}
        </p>
      ) : null}
    </div>
  );
}
