'use client';

import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { FIELD_FOCUS } from '../lib/styles';
import { Icon } from './Icon';

export type InputKind = 'text' | 'username' | 'digits';

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value'
> {
  label: string;
  value: string;
  /** Receives the already-cleaned value (see `kind`). */
  onValueChange: (value: string) => void;
  /**
   * text: as typed. username: shows a fixed "@" and keeps only A-Z a-z 0-9 _ (so a pasted
   * "@name" works). digits: numeric keypad, digits only, tabular.
   */
  kind?: InputKind;
  help?: ReactNode;
  /** Replaces the help text and colours the field; never the only signal (icon + text). */
  error?: ReactNode;
  /** Shown instead of help when the value is accepted. */
  success?: ReactNode;
  /** Optional hint appended to the label, e.g. "· ixt." */
  labelNote?: string;
}

const CLEANERS: Record<InputKind, (raw: string) => string> = {
  text: (raw) => raw,
  username: (raw) => raw.replace(/[^A-Za-z0-9_]/g, ''),
  digits: (raw) => raw.replace(/\D/g, ''),
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    labelNote,
    value,
    onValueChange,
    kind = 'text',
    help,
    error,
    success,
    className,
    disabled,
    id,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const messageId = `${fieldId}-message`;
  const hasError = Boolean(error);
  const message = error ?? success ?? help;

  return (
    <div className={cn('flex flex-col gap-1.5', disabled && 'opacity-55')}>
      <label htmlFor={fieldId} className="text-[13px] leading-[18px] font-bold">
        {label}
        {labelNote ? <span className="font-medium text-foreground-muted"> {labelNote}</span> : null}
      </label>
      <div className="relative flex">
        {kind === 'username' ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-[15px] font-bold text-foreground-muted"
          >
            @
          </span>
        ) : null}
        <input
          ref={ref}
          id={fieldId}
          value={value}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={message ? messageId : undefined}
          onChange={(event) => onValueChange(CLEANERS[kind](event.target.value))}
          {...(kind === 'username'
            ? { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, autoComplete: 'off' }
            : {})}
          {...(kind === 'digits' ? { inputMode: 'numeric' as const } : {})}
          {...rest}
          className={cn(
            'h-12 min-w-0 flex-1 rounded-control border-[1.5px] bg-input px-3.5 text-[15px] leading-none font-semibold',
            'border-input-border text-foreground transition duration-fast ease-standard',
            kind === 'username' && 'pl-8',
            kind === 'digits' && 'font-bold tracking-[.04em] tabular-nums',
            hasError && 'border-danger pr-10',
            disabled && 'border-border bg-muted text-foreground-muted',
            FIELD_FOCUS,
            hasError && 'focus:border-danger focus:ring-danger-soft',
            className,
          )}
        />
        {hasError ? (
          <Icon
            icon={CircleAlert}
            size={18}
            className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-danger"
          />
        ) : null}
      </div>
      {message ? (
        <span
          id={messageId}
          role={hasError ? 'alert' : undefined}
          className={cn(
            'flex items-center gap-1.5 text-xs leading-4',
            hasError
              ? 'font-semibold text-danger-text'
              : success
                ? 'font-semibold text-success-text'
                : 'font-medium text-foreground-muted',
          )}
        >
          {hasError ? <Icon icon={CircleX} size={13} className="shrink-0" /> : null}
          {!hasError && success ? <Icon icon={CircleCheck} size={13} className="shrink-0" /> : null}
          <span className="min-w-0">{message}</span>
        </span>
      ) : null}
    </div>
  );
});
