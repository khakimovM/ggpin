'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { MONEY_PLACEHOLDER } from '../../lib/format/money';
import type { Selection } from './use-quote';

/** "500 ⭐" for a free quantity, the package's own label ("3 oylik") for a package. */
export function useSelectionLabel(): (
  product: CatalogProductDetail,
  selection: Selection | null,
) => string {
  const t = useTranslations('store.product');
  return useCallback(
    (product, selection) => {
      if (selection === null) return MONEY_PLACEHOLDER;
      if (selection.kind === 'qty') return t('summary.stars', { count: selection.quantity });
      return product.skus.find((sku) => sku.id === selection.skuId)?.label ?? MONEY_PLACEHOLDER;
    },
    [t],
  );
}
