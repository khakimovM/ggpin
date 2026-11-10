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
          ? // py-1 / -my-1: room for the chips' 44 px hit area, which overflow-x-auto would clip.
            '-mx-4 -my-1 overflow-x-auto px-4 py-1 [scrollbar-width:none]'
          : 'flex-wrap gap-1.5',
      )}
    >
      {ORDER_FILTERS.map((filter) => (
        <Chip
          key={filter}
          selected={filter === value}
          onClick={() => onChange(filter)}
          // Store.dc.html: 38 px tall chips, 6 px apart, so wrapped rows sit 44 px apart and the 44 px
          // hit areas of two rows touch without overlapping.
          className={variant === 'tg' ? 'shrink-0 whitespace-nowrap' : 'min-h-[38px]'}
        >
          {t(filter)}
        </Chip>
      ))}
    </div>
  );
}
