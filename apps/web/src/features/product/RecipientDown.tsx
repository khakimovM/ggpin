'use client';

import { Button, Icon } from '@repo/ui';
import { CloudOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCountdown } from '../auth/use-countdown';

export interface RecipientDownProps {
  onRetry: () => void;
  /** Epoch ms before which the server refuses another check (429 + Retry-After), else null. */
  retryAt: number | null;
}

/**
 * The check could not be made. "Qayta urinish" asks again, except while the server told us to
 * wait (a 429): then the button stays off and counts the seconds down.
 */
export function RecipientDown({ onRetry, retryAt }: RecipientDownProps) {
  const t = useTranslations('store.product.recipient');
  const common = useTranslations('common');
  const leftMs = useCountdown(retryAt);
  const waiting = retryAt !== null && leftMs > 0;
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 rounded-[14px] bg-warning-soft py-2.5 pr-2.5 pl-3 text-[13px] leading-[18px] font-bold text-warning-text"
    >
      <Icon icon={CloudOff} size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">{t('down')}</span>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={waiting}>
        {waiting ? `${common('retry')} (${Math.ceil(leftMs / 1000)})` : common('retry')}
      </Button>
    </div>
  );
}
