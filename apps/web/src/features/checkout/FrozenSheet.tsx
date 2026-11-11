'use client';

import { Button, Icon, Sheet } from '@repo/ui';
import { Snowflake } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SupportLinkButton } from '../support/SupportLinkButton';

export interface FrozenSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An earlier purchase of this user is still in doubt: the sheet reminds them of it. */
  uncertain?: boolean;
}

/**
 * `403 PURCHASE_FROZEN`: a payment of the visitor's was refunded, so new purchases wait for
 * support. The message says so and leads to support; there is nothing to retry.
 */
export function FrozenSheet({ open, onOpenChange, uncertain = false }: FrozenSheetProps) {
  const t = useTranslations('store.checkout.frozen');
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      hideTitle
      closeLabel={t('close')}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 pt-1 text-center">
          <span
            aria-hidden="true"
            className="grid size-[72px] place-items-center rounded-full bg-info-soft text-info-text"
          >
            <Icon icon={Snowflake} size={32} />
          </span>
          <h2 className="m-0 text-[22px] leading-7 font-extrabold">{t('title')}</h2>
          <p className="m-0 max-w-[320px] text-[15px] leading-[22px] font-medium text-foreground-secondary">
            {t('body')}
          </p>
          {uncertain ? (
            <p className="m-0 max-w-[320px] rounded-2xl bg-warning-soft p-3 text-[13px] leading-[18px] font-bold text-warning-text">
              {t('uncertain')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <SupportLinkButton variant="secondary" className="w-full">
            {t('support')}
          </SupportLinkButton>
          <Button variant="ghost" size="lg" onClick={() => onOpenChange(false)} className="w-full">
            {t('close')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
