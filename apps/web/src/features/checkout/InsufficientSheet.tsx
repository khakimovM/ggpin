'use client';

import type { InsufficientBalanceDetails } from '@repo/shared';
import { Badge, Button, Icon, Sheet } from '@repo/ui';
import { Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Money } from '../../lib/format/money';

export interface InsufficientSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server's numbers (`details.balance`, `required`, `shortfall`); none is worked out here. */
  details: InsufficientBalanceDetails;
}

/**
 * "Mablag‘ yetarli emas" (Checkout.dc.html `insufficient`). The top-up buttons belong to the
 * wallet slice (S8): until it exists the only way on is "Hisobni to‘ldirish" marked "Tez orada"
 * and off, and "Yopish". "{amount} to‘ldirish va sotib olish" is not drawn at all yet.
 */
export function InsufficientSheet({ open, onOpenChange, details }: InsufficientSheetProps) {
  const t = useTranslations('store.checkout.insufficient');
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
            className="grid size-[72px] place-items-center rounded-full bg-warning-soft text-warning-text"
          >
            <Icon icon={Wallet} size={32} />
          </span>
          <h2 className="m-0 text-[22px] leading-7 font-extrabold">{t('title')}</h2>
        </div>

        <dl className="m-0 flex flex-col gap-2.5 rounded-2xl bg-muted p-4 text-[15px] leading-5 font-semibold tabular-nums">
          <div className="flex justify-between gap-3">
            <dt className="text-foreground-secondary">{t('balance')}</dt>
            <dd className="m-0">
              <Money tiyin={details.balance} size="md" />
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-foreground-secondary">{t('price')}</dt>
            <dd className="m-0">
              <Money tiyin={details.required} size="md" />
            </dd>
          </div>
          <div className="h-px bg-border" />
          <div className="flex justify-between gap-3 font-extrabold text-danger-text">
            <dt>{t('shortfall')}</dt>
            <dd className="m-0">
              <Money tiyin={details.shortfall} size="md" className="text-danger-text" />
            </dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2">
          <Button size="lg" disabled className="relative w-full">
            {t('topup')}
            <Badge size="sm" variant="soon" className="absolute -top-2 right-3">
              {t('soon')}
            </Badge>
          </Button>
          <Button variant="ghost" size="lg" onClick={() => onOpenChange(false)} className="w-full">
            {t('close')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
