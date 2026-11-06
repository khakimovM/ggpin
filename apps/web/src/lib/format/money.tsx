'use client';

import { MoneyText, type MoneyTextProps } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { formatTiyinString } from './tiyin';

// Shown when a value is not a tiyin string; a broken amount must not crash the screen or
// pretend to be zero.
export const MONEY_PLACEHOLDER = '—';

/** Full text with the unit ("12 550 so‘m" / "12 550 сум") for plain-text uses. */
export function useFormatMoney(): (tiyin: string) => string {
  const locale = useLocale();
  const t = useTranslations('common.money');
  return useCallback(
    (tiyin: string) => {
      const amount = formatTiyinString(tiyin, locale);
      return amount === null ? MONEY_PLACEHOLDER : t('uzs', { amount });
    },
    [locale, t],
  );
}

export type MoneyProps = { tiyin: string } & Omit<MoneyTextProps, 'amount' | 'unit'>;

/** An amount from a tiyin string, in the design's money style (see `MoneyText`). */
export function Money({ tiyin, ...textProps }: MoneyProps) {
  const locale = useLocale();
  const t = useTranslations('common.currency');
  const amount = formatTiyinString(tiyin, locale);
  if (amount === null) return <span className={textProps.className}>{MONEY_PLACEHOLDER}</span>;
  return <MoneyText amount={amount} unit={t('uzs')} {...textProps} />;
}
