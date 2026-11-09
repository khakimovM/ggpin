'use client';

import { Button, Icon } from '@repo/ui';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { mmss } from './PayCountdown';
import { WaitingDot } from './WaitingDot';

export interface PayBarProps {
  /** The last poll failed and nothing newer arrived. */
  netError: boolean;
  onRetry: () => void;
  retrying: boolean;
  /** The page shows the time left here too; the modal shows a cancel button instead. */
  msLeft?: number;
  onCancel?: () => void;
  cancelLabel?: string;
  /** Fixed to the bottom of the viewport on the page; a plain footer inside the modal. */
  sticky?: boolean;
}

/**
 * The status bar under the payment (PayPage.dc.html): "To'lov kutilmoqda…" with a live dot and the
 * time left, or, after a failed poll, "Ulanishda xatolik" with a retry. It announces changes.
 */
export function PayBar({
  netError,
  onRetry,
  retrying,
  msLeft,
  onCancel,
  cancelLabel,
  sticky = false,
}: PayBarProps) {
  const t = useTranslations('pay');
  return (
    <div
      role="status"
      aria-live="polite"
      className={`z-5 flex items-center gap-3 border-t border-border bg-surface/95 px-4 py-3.5 backdrop-blur-md ${
        sticky ? 'sticky bottom-0 pb-[max(14px,env(safe-area-inset-bottom))]' : ''
      }`}
    >
      {netError ? (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2.5 text-sm font-bold text-danger-text">
            <Icon icon={WifiOff} size={18} className="shrink-0" />
            {t('netError')}
          </span>
          <Button size="md" loading={retrying} onClick={onRetry}>
            <Icon icon={RefreshCw} size={15} />
            {t('retry')}
          </Button>
        </>
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2.5 text-sm font-bold">
            <WaitingDot />
            {t('waiting')}
          </span>
          {onCancel === undefined ? null : (
            <Button variant="outline" size="md" onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
          {msLeft === undefined ? null : (
            <span className="text-sm font-extrabold whitespace-nowrap tabular-nums">
              {mmss(msLeft)}
            </span>
          )}
        </>
      )}
    </div>
  );
}
