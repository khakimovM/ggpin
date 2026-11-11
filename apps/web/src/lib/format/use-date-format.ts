'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { formatCountdown, formatDateTime, formatUserDateTime } from './date';

export interface DateFormatters {
  /** "Bugun, 14:05" / "Kecha, 14:05" / "15-noyabr, 14:05". */
  userDateTime: (date: Date) => string;
  /** "15-noyabr, 14:05" without the relative words (tooltips, details). */
  dateTime: (date: Date) => string;
  /** "M:SS". */
  countdown: (remainingMs: number) => string;
}

export function useDateFormat(): DateFormatters {
  const locale = useLocale();
  const t = useTranslations('common');
  const today = t('today');
  const yesterday = t('yesterday');
  return useMemo(
    () => ({
      userDateTime: (date) => formatUserDateTime(date, { locale, labels: { today, yesterday } }),
      dateTime: (date) => formatDateTime(date, { locale }),
      countdown: formatCountdown,
    }),
    [locale, today, yesterday],
  );
}
