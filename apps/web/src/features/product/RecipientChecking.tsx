'use client';

import { Skeleton } from '@repo/ui';
import { useTranslations } from 'next-intl';

/** The lookup is running (Product.dc.html `recipient: checking`). */
export function RecipientChecking() {
  const t = useTranslations('store.product.recipient');
  return (
    <div
      aria-busy="true"
      className="flex items-center gap-3 rounded-[18px] border-[1.5px] border-border p-3"
    >
      <span className="sr-only" role="status">
        {t('checking')}
      </span>
      <Skeleton shape="circle" className="size-12" />
      <span className="flex flex-1 flex-col gap-2">
        <Skeleton shape="text" className="h-4 w-32" />
        <Skeleton shape="text" className="h-3 w-20" />
      </span>
    </div>
  );
}
