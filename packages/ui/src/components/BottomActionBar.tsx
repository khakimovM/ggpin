'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { Skeleton } from './Skeleton';

export interface BottomActionBarProps {
  /** Label of the main button, e.g. "To‘lash". */
  label: string;
  onAction?: () => void;
  /** Left-hand line above the button, e.g. "Hamyonda: 85 400 so‘m". */
  hint?: ReactNode;
  /** warning shows the hint with a warning tone (insufficient balance). */
  hintTone?: 'muted' | 'warning';
  /** Server price, usually a <MoneyText>. */
  price?: ReactNode;
  /** The quote is being fetched: the price slot shows a skeleton and the button is disabled. */
  priceLoading?: boolean;
  /** Disabled button that says why, e.g. "Qabul qiluvchini tasdiqlang". Replaces the label. */
  disabledReason?: string;
  /** Request in flight (e.g. paying): spinner, busy state. */
  loading?: boolean;
  /** Label while loading, e.g. "To‘lanmoqda…". */
  loadingLabel?: string;
  /** Icon shown before the label (e.g. the wallet icon for "top up"). */
  icon?: ReactNode;
  /** Pin to the bottom of the viewport. */
  fixed?: boolean;
  className?: string;
}

// Web bar and the Mini App fallback; in Telegram the same label is handed to the native
// MainButton. Bottom padding = 12 + the safe area (the Telegram insets arrive as --tg-safe-bottom).
export function BottomActionBar({
  label,
  onAction,
  hint,
  hintTone = 'muted',
  price,
  priceLoading = false,
  disabledReason,
  loading = false,
  loadingLabel,
  icon,
  fixed = false,
  className,
}: BottomActionBarProps) {
  const blocked = Boolean(disabledReason) || priceLoading;
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border border-border bg-surface px-4 pt-3',
        'pb-[calc(12px+max(env(safe-area-inset-bottom),var(--tg-safe-bottom,0px)))]',
        fixed && 'fixed inset-x-0 bottom-0 z-30 rounded-b-none',
        className,
      )}
    >
      {hint || price || priceLoading ? (
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'min-w-0 text-[13px] leading-[18px]',
              hintTone === 'warning'
                ? 'flex items-center gap-1.5 font-bold text-warning-text'
                : 'font-medium text-foreground-muted',
            )}
          >
            {hint}
          </span>
          {priceLoading ? (
            <Skeleton className="h-[22px] w-24 rounded-xs" />
          ) : (
            <span className="shrink-0 text-[17px] leading-[22px] font-extrabold tabular-nums">
              {price}
            </span>
          )}
        </div>
      ) : null}
      <Button
        size="lg"
        glow={!blocked}
        disabled={blocked}
        loading={loading}
        onClick={onAction}
        className="w-full"
      >
        {!loading && !blocked ? icon : null}
        {loading ? (loadingLabel ?? label) : (disabledReason ?? label)}
      </Button>
    </div>
  );
}
