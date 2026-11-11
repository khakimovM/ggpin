'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

export interface OrderItem {
  productSlug: string;
  productName: string;
  quantity: number;
}

/**
 * "500 ⭐" / "Premium: 3 oylik": what the order delivers, in words for the hero text. The two
 * Telegram products have their own phrasing (a star count, a number of months); any other product
 * is its catalog name until its own phrasing exists.
 */
export function useItemLabel(): (item: OrderItem) => string {
  const t = useTranslations('store.order.item');
  return useCallback(
    (item) => {
      switch (item.productSlug) {
        case 'telegram-stars':
          return t('stars', { count: item.quantity });
        case 'telegram-premium':
          return t('premium', { count: item.quantity });
        default:
          return item.productName;
      }
    },
    [t],
  );
}
