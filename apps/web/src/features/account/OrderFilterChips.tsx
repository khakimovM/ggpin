'use client';

import { Chip, cn } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { ORDER_FILTERS, type OrderFilter } from './order-filters';

/**
 * Barchasi / Bajarildi / Kutilmoqda / Bekor qilingan (Account.dc.html `oChips`). In the Mini App
 * the row scrolls sideways under the page padding; on the web it wraps.
 */
export function OrderFilterChips({
  value,
  onChange,
  variant,
}: {
  value: OrderFilter;
  onChange: (filter: OrderFilter) => void;
  variant: 'tg' | 'web';
}) {
  const t = useTranslations('account.history.filter');
  return (
    <div
      role="group"
      aria-label={t('label')}
      className={cn(
        'flex gap-2',
        variant === 'tg'
          ? '-mx-4 overflow-x-auto px-4 [scrollbar-width:none]'
          : 'flex-wrap gap-1.5',
      )}
    >
      {ORDER_FILTERS.map((filter) => (
        <Chip
          key={filter}
          selected={filter === value}
          onClick={() => onChange(filter)}
          className={variant === 'tg' ? 'shrink-0 whitespace-nowrap' : undefined}
        >
          {t(filter)}
        </Chip>
      ))}
    </div>
  );
}
