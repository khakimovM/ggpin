'use client';

import { Button, Icon, Sheet } from '@repo/ui';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface CancelDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  cancelling: boolean;
  failed: boolean;
}

/**
 * "To'lovni bekor qilasizmi?" (TopupMini.dc.html): a cancelled request frees nothing for 24 hours
 * and money sent to it afterwards is not credited by itself, so the dialog first says "if you have
 * already sent the money, do not cancel".
 */
export function CancelDialog({ open, onClose, onConfirm, cancelling, failed }: CancelDialogProps) {
  const t = useTranslations('store.topup');
  const tg = useTranslations('tg.topup');
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && !cancelling && onClose()}
      title={t('cancelDialog.title')}
      hideTitle
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 pt-1 text-center">
          <span
            aria-hidden="true"
            className="grid size-[72px] place-items-center rounded-full bg-warning-soft text-warning-text"
          >
            <Icon icon={TriangleAlert} size={32} />
          </span>
          <h2 className="m-0 text-[22px] leading-7 font-extrabold">{t('cancelDialog.title')}</h2>
          <p className="m-0 max-w-[320px] text-[15px] leading-[22px] font-medium text-foreground-secondary">
            {t('cancelDialog.note')}
          </p>
        </div>
        {failed ? (
          <p role="alert" className="m-0 text-center text-sm font-bold text-danger-text">
            {tg('waiting.cancelError')}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            variant="danger"
            size="lg"
            loading={cancelling}
            onClick={onConfirm}
            className="w-full"
          >
            {t('cancelDialog.yes')}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            disabled={cancelling}
            onClick={onClose}
            className="w-full"
          >
            {t('cancelDialog.no')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
