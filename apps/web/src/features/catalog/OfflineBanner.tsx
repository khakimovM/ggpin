'use client';

import { HIT_AREA_44, Icon } from '@repo/ui';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** MiniApp.dc.html `state: offline`: prices and balance on screen may be stale; one tap retries. */
export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('store.catalog.offline');
  const common = useTranslations('common');
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-2xl bg-warning-soft py-2.5 pr-2.5 pl-3.5 text-warning-text"
    >
      <Icon icon={WifiOff} size={20} className="shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-sm leading-[18px] font-extrabold">{t('title')}</span>
        <span className="text-xs leading-4 font-semibold text-foreground-secondary">
          {t('body')}
        </span>
      </span>
      <button
        type="button"
        aria-label={common('retry')}
        onClick={onRetry}
        className={`relative grid size-10 shrink-0 place-items-center rounded-xl bg-card text-foreground focus-visible:outline-2 focus-visible:outline-ring ${HIT_AREA_44}`}
      >
        <Icon icon={RefreshCw} size={17} />
      </button>
    </div>
  );
}
