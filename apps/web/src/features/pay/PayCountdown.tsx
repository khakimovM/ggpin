'use client';

import { TOPUP_DEFAULTS } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Clock, Timer } from 'lucide-react';
import { useTranslations } from 'next-intl';

const LOW_MS = 5 * 60 * 1000;
const TOTAL_MS = TOPUP_DEFAULTS.INTENT_TTL_SEC * 1000;

/** "29:41" from milliseconds; the countdown is for the eye, the server decides when it ends. */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export interface PayCountdownProps {
  msLeft: number;
}

/**
 * "To'lov muddati 29:41" with a thin bar (PayPage.dc.html timer card). Under five minutes the card
 * turns to the warning tone and says so in words, not only in colour.
 */
export function PayCountdown({ msLeft }: PayCountdownProps) {
  const t = useTranslations('pay');
  const low = msLeft < LOW_MS;
  const width = `${Math.min(100, Math.max(0, (msLeft / TOTAL_MS) * 100))}%`;
  return (
    // A div, not a section: `timer` is not an allowed role of <section> (axe aria-allowed-role).
    <div
      role="timer"
      aria-live="off"
      data-low={low ? '' : undefined}
      className={`flex flex-col gap-2.5 rounded-[20px] border p-4 ${
        low ? 'border-warning bg-warning-soft text-warning-text' : 'border-border bg-card'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[15px] leading-5 font-extrabold">
          <Icon icon={low ? Timer : Clock} size={17} />
          {low ? t('lowLeft') : t('timeLabel')}
        </span>
        <span
          data-testid="pay-left"
          className="text-lg leading-none font-extrabold whitespace-nowrap tabular-nums"
        >
          {t('left', { time: mmss(msLeft) })}
        </span>
      </div>
      <span className="h-1.5 overflow-hidden rounded-[3px] bg-muted">
        <span
          className={`block h-full rounded-[3px] transition-[width] duration-[1000ms] ease-linear motion-reduce:transition-none ${
            low ? 'bg-warning' : 'bg-primary'
          }`}
          style={{ width }}
        />
      </span>
    </div>
  );
}
