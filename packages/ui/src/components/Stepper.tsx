'use client';

import { Minus, Plus } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { FIELD_FOCUS, FOCUS_RING } from '../lib/styles';
import { Icon } from './Icon';

export interface StepperProps {
  label: string;
  /** Digits as typed; the parent decides what an out-of-range value means (show `error`). */
  value: string;
  onValueChange: (value: string) => void;
  min: number;
  max: number;
  /** Amount added or removed by the buttons. */
  step?: number;
  decrementLabel: string;
  incrementLabel: string;
  /** Glyph inside the field, e.g. the star for Stars. */
  adornment?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  maxDigits?: number;
}

// Quantities are counts (stars, months), not money, so plain numbers are fine here.
export function Stepper({
  label,
  value,
  onValueChange,
  min,
  max,
  step = 1,
  decrementLabel,
  incrementLabel,
  adornment,
  help,
  error,
  disabled,
  maxDigits = 6,
}: StepperProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const current = value === '' ? 0 : Number(value);
  const message = error ?? help;

  const move = (delta: number) => {
    const base = Number.isFinite(current) ? current : min;
    onValueChange(String(Math.min(max, Math.max(min, base + delta))));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] leading-[18px] font-bold">
        {label}
      </label>
      <div className="grid grid-cols-[48px_minmax(0,1fr)_48px] gap-2">
        <button
          type="button"
          aria-label={decrementLabel}
          disabled={disabled || current <= min}
          onClick={() => move(-step)}
          className={cn(
            'grid h-12 place-items-center rounded-control border-[1.5px] border-border bg-card text-foreground',
            'transition duration-fast ease-standard active:scale-[.94] disabled:pointer-events-none disabled:text-foreground-muted disabled:opacity-60',
            FOCUS_RING,
          )}
        >
          <Icon icon={Minus} size={20} />
        </button>
        <div className="relative flex">
          <input
            id={id}
            inputMode="numeric"
            autoComplete="off"
            value={value}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={message ? messageId : undefined}
            onChange={(event) =>
              onValueChange(event.target.value.replace(/\D/g, '').slice(0, maxDigits))
            }
            className={cn(
              'h-12 min-w-0 flex-1 rounded-control border-[1.5px] border-input-border bg-input text-center',
              'text-lg leading-none font-extrabold text-foreground tabular-nums transition duration-fast ease-standard',
              adornment ? 'pr-7 pl-2' : 'px-2',
              error && 'border-danger',
              FIELD_FOCUS,
              error && 'focus:border-danger focus:ring-danger-soft',
            )}
          />
          {adornment ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[15px]"
            >
              {adornment}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={incrementLabel}
          disabled={disabled || current >= max}
          onClick={() => move(step)}
          className={cn(
            'grid h-12 place-items-center rounded-control bg-primary text-primary-foreground',
            'transition duration-fast ease-standard hover:bg-primary-hover active:scale-[.94]',
            'disabled:pointer-events-none disabled:bg-muted disabled:text-foreground-muted',
            FOCUS_RING,
          )}
        >
          <Icon icon={Plus} size={20} />
        </button>
      </div>
      {message ? (
        <span
          id={messageId}
          role={error ? 'alert' : undefined}
          className={cn(
            'text-xs leading-4',
            error ? 'font-semibold text-danger-text' : 'font-medium text-foreground-muted',
          )}
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}
