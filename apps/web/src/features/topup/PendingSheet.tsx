'use client';

import type { TopupIntent } from '@repo/shared';
import { Button, Icon, Sheet } from '@repo/ui';
import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Money } from '../../lib/format/money';
import { mmss } from '../pay/PayCountdown';
import { TopupNotes } from './TopupNotes';

export interface PendingSheetProps {
  open: boolean;
  intent: TopupIntent;
  msLeft: number;
  onOpenPage: () => void;
  onCancelAndNew: () => void;
  onClose: () => void;
  busy: 'open' | 'cancel' | null;
  failed: boolean;
}

/**
 * "Sizda tugallanmagan to'lov bor" (TopupMini.dc.html): a request is already waiting (only one at
 * a time), so a new one cannot start. It shows the amount and the time left and offers to open its
 * payment page, or to cancel it and begin again.
 */
export function PendingSheet({
  open,
  intent,
  msLeft,
  onOpenPage,
  onCancelAndNew,
  onClose,
  busy,
  failed,
}: PendingSheetProps) {
  const t = useTranslations('store.topup');
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('pending.title')}
      hideTitle
      closeLabel={t('pending.close')}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 pt-1 text-center">
          <span
            aria-hidden="true"
            className="grid size-[72px] place-items-center rounded-full bg-info-soft text-info-text"
          >
            <Icon icon={Clock} size={32} />
          </span>
          <h2 className="m-0 text-[22px] leading-7 font-extrabold">{t('pending.title')}</h2>
          <Money tiyin={intent.payAmountTiyin} size="lg" />
          <span className="text-sm font-bold text-foreground-secondary tabular-nums">
            {t('pending.left', { time: mmss(msLeft) })}
          </span>
        </div>
        <TopupNotes />
        {failed ? (
          <p role="alert" className="m-0 text-center text-sm font-bold text-danger-text">
            {t('pending.error')}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            glow
            loading={busy === 'open'}
            disabled={busy !== null}
            onClick={onOpenPage}
            className="w-full"
          >
            {t('pending.open')}
          </Button>
          <Button
            variant="outline"
            size="lg"
            loading={busy === 'cancel'}
            disabled={busy !== null}
            onClick={onCancelAndNew}
            className="w-full"
          >
            {t('pending.cancelNew')}
          </Button>
          <Button variant="ghost" size="lg" onClick={onClose} className="w-full">
            {t('pending.close')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
