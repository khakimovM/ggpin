'use client';

import { cn } from '@repo/ui';
import type { KeyboardEvent } from 'react';

export interface HistoryTabOption<V extends string> {
  value: V;
  label: string;
}

export interface HistoryTabsProps<V extends string> {
  options: readonly HistoryTabOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  ariaLabel: string;
  /** Id prefix shared with the panel: `${idBase}-tab-<value>` and `${idBase}-panel`. */
  idBase: string;
  /** tg: 40 px segments across the width; web: 38 px segments with padding, as in the header row. */
  size: 'tg' | 'web';
}

/**
 * The pill tabs of the history (Account.dc.html `hTabs`). A real tablist: arrow keys move the
 * selection (roving tabindex), and the selected tab names the panel below it.
 */
export function HistoryTabs<V extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  idBase,
  size,
}: HistoryTabsProps<V>) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onValueChange(option.value);
    document.getElementById(`${idBase}-tab-${option.value}`)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'flex gap-1 rounded-full bg-muted p-1',
        size === 'tg' ? 'w-full' : 'w-full sm:w-auto',
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            id={`${idBase}-tab-${option.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idBase}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'relative flex-1 cursor-pointer rounded-full border-none text-sm leading-none font-extrabold transition-colors duration-base ease-standard',
              'before:absolute before:inset-x-0 before:-inset-y-1 before:content-[""]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              size === 'tg' ? 'h-10' : 'h-[38px] sm:flex-none sm:px-[18px]',
              selected
                ? 'bg-card text-foreground shadow-sm'
                : 'bg-transparent text-foreground-muted hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
