'use client';

import { X } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { FOCUS_RING, HIT_AREA_44 } from '../lib/styles';
import { Icon } from './Icon';

interface ChipCommonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

/**
 * filter: category / status filter, selected = filled primary.
 * quick: quick amount or quantity, selected = soft primary.
 * removable: an applied filter with a remove button. The remove handler and its accessible name
 * come as a pair (a nameless icon button is an accessibility error), so one without the other
 * does not compile.
 */
export type ChipProps = ChipCommonProps &
  (
    | { variant?: 'filter' | 'quick'; onRemove?: undefined; removeLabel?: undefined }
    | { variant: 'removable'; onRemove: () => void; removeLabel: string }
  );

const BASE =
  `relative ${HIT_AREA_44} ` +
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-full border-[1.5px] px-3.5 py-1.5 ' +
  'text-center text-[13px] leading-tight font-bold tabular-nums transition duration-fast ease-standard';

// Chips wrap their label (Russian is longer); horizontal scrolling lists add `shrink-0` themselves.
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  {
    variant = 'filter',
    selected = false,
    onRemove,
    removeLabel,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  if (variant === 'removable') {
    return (
      <span
        className={cn(
          // gap-3 (12px): the remove button's 44px hit area reaches 11px to its left, so a tap on the
          // label never removes the filter.
          'inline-flex min-h-8 items-center gap-3 rounded-full py-1 pr-1.5 pl-3 text-[13px] leading-tight font-bold',
          // Disabled keeps full-strength text on a muted fill (no opacity: it would drop below AA).
          disabled
            ? 'bg-muted text-foreground-muted'
            : 'bg-primary-soft text-primary-soft-foreground',
          className,
        )}
      >
        <span className="min-w-0">{children}</span>
        <button
          type="button"
          aria-label={removeLabel}
          disabled={disabled}
          onClick={onRemove}
          className={cn(
            'relative grid size-[22px] shrink-0 place-items-center rounded-full text-inherit hover:bg-primary/10',
            HIT_AREA_44,
            FOCUS_RING,
          )}
        >
          <Icon icon={X} size={14} />
        </button>
      </span>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={variant === 'filter' || selected ? selected : undefined}
      disabled={disabled}
      className={cn(
        BASE,
        FOCUS_RING,
        'disabled:pointer-events-none disabled:opacity-60',
        variant === 'filter' &&
          (selected
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-card text-foreground-secondary hover:border-input-border hover:text-foreground'),
        variant === 'quick' &&
          (selected
            ? 'border-primary bg-primary-soft text-primary-soft-foreground'
            : 'border-border bg-card text-foreground-secondary hover:border-input-border hover:text-foreground'),
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
