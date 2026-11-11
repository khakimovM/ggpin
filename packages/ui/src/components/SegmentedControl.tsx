'use client';

import { motion } from 'motion/react';
import { ToggleGroup } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE } from '../lib/motion';
import { FOCUS_RING, HIT_AREA_44 } from '../lib/styles';

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Needed when the label is an icon or abbreviation (e.g. "RU" -> "Русский"). */
  ariaLabel?: string;
}

export interface SegmentedControlProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  /** Accessible name of the group. */
  ariaLabel: string;
  /**
   * primary: the selected segment is a filled primary pill (2-3 views of one list).
   * neutral: the selected segment is a raised card (language switch).
   */
  variant?: 'primary' | 'neutral';
  /** md: 40px segments; sm: 36px, tighter (language switch, admin). */
  size?: 'md' | 'sm';
  className?: string;
}

// 2-4 options. Radix ToggleGroup gives arrow-key navigation; a selected segment cannot be
// toggled off. The selection thumb slides between segments (ease-standard, 220ms); under
// reduced motion layout animation is disabled by MotionConfig and the thumb just swaps.
export function SegmentedControl<V extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  variant = 'primary',
  size = 'md',
  className,
}: SegmentedControlProps<V>) {
  const thumbId = useId();
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(next) => {
        // Radix reports '' when the selected item is pressed again; ignore it, and map the
        // string back to one of our own option values instead of casting.
        const option = options.find((candidate) => candidate.value === next);
        if (option) onValueChange(option.value);
      }}
      className={cn(
        'inline-flex max-w-full gap-1 rounded-full bg-muted',
        size === 'md' ? 'w-full max-w-[390px] p-1' : 'gap-0.5 p-[3px]',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            aria-label={option.ariaLabel}
            className={cn(
              'relative grid place-items-center rounded-full px-3 text-center font-bold transition-colors duration-base ease-standard',
              size === 'md'
                ? `min-h-10 flex-1 text-sm ${HIT_AREA_44}`
                : `min-h-9 min-w-11 text-[13px] font-extrabold tracking-[.02em] ${HIT_AREA_44}`,
              selected
                ? variant === 'primary'
                  ? 'text-primary-foreground'
                  : 'text-foreground'
                : variant === 'primary'
                  ? 'text-foreground-secondary'
                  : 'text-foreground-muted',
              FOCUS_RING,
            )}
          >
            {selected ? (
              <motion.span
                layoutId={thumbId}
                aria-hidden="true"
                transition={{ duration: DURATION.base, ease: EASE.standard }}
                className={cn(
                  'absolute inset-0 rounded-full shadow-sm',
                  variant === 'primary' ? 'bg-primary' : 'bg-card',
                )}
              />
            ) : null}
            <span className="relative">{option.label}</span>
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}
