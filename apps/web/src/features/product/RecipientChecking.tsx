'use client';

import { Skeleton } from '@repo/ui';
import { useTranslations } from 'next-intl';

export interface RecipientCheckingProps {
  /** The lookup is running: the skeleton card shows and the live region says so. */
  active: boolean;
}

/**
 * The lookup is running (Product.dc.html `recipient: checking`). The screen-reader live region is
 * always mounted and only its text changes: NVDA and JAWS do not read a `role="status"` that
 * enters the DOM together with its text. It is `sr-only` (absolutely positioned), so it takes no
 * place in the form's flex column and the form looks exactly as before.
 */
export function RecipientChecking({ active }: RecipientCheckingProps) {
  const t = useTranslations('store.product.recipient');
  return (
    <>
      <span className="sr-only" role="status">
        {active ? t('checking') : null}
      </span>
      {active ? (
        <div
          aria-busy="true"
          className="flex items-center gap-3 rounded-[18px] border-[1.5px] border-border p-3"
        >
          <Skeleton shape="circle" className="size-12" />
          <span className="flex flex-1 flex-col gap-2">
            <Skeleton shape="text" className="h-4 w-32" />
            <Skeleton shape="text" className="h-3 w-20" />
          </span>
        </div>
      ) : null}
    </>
  );
}
