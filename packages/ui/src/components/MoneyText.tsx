import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface MoneyTextProps {
  /** Pre-formatted amount without the unit, e.g. "85 400" or "−1 200" (formatMoney output). */
  amount: string;
  /** Localised currency word, e.g. "so‘m" / "сум". */
  unit: string;
  /**
   * sm: 13/18 inline; md: 15/20; lg: 17/22 price; xl: balance, Unbounded 40/44 with a small unit.
   */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** credit: green with a leading "+"; muted: secondary text; default: plain (debits are never red). */
  tone?: 'default' | 'credit' | 'muted';
  className?: string;
  /** Extra content inside the same line (e.g. a note), rendered after the unit. */
  children?: ReactNode;
}

const NBSP = ' ';
const MINUS = '−';

const SIZES = {
  sm: 'text-[13px] leading-[18px] font-semibold',
  md: 'text-[15px] leading-5 font-extrabold',
  lg: 'text-[17px] leading-[22px] font-extrabold',
  xl: 'font-display text-[40px] leading-[44px] font-semibold tracking-[-.03em]',
} as const;

const TONES = {
  default: '',
  credit: 'text-success-text',
  muted: 'text-foreground-secondary',
} as const;

// The amount comes already formatted (and already carries "−" for negatives): the browser never
// computes or rounds money, it only lays out what the server sent.
export function MoneyText({
  amount,
  unit,
  size = 'lg',
  tone = 'default',
  className,
  children,
}: MoneyTextProps) {
  const signed = tone === 'credit' && !amount.startsWith(MINUS) && !amount.startsWith('+');
  return (
    <span className={cn('tabular-nums whitespace-nowrap', SIZES[size], TONES[tone], className)}>
      {signed ? '+' : ''}
      {amount}
      {NBSP}
      <span
        className={cn(
          size === 'xl' &&
            'ml-0.5 font-sans text-[17px] leading-[22px] font-bold tracking-normal text-foreground-muted',
        )}
      >
        {unit}
      </span>
      {children}
    </span>
  );
}
