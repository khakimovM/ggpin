import { cn } from '@repo/ui';
import { useId } from 'react';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Leaving the field (an editor shows its error only after that). */
  onBlur?: () => void;
  /** A muted line under the field; replaced by `error` when there is one. */
  hint?: string;
  error?: string | null;
  multiline?: boolean;
  /** Text typed as a code or a number (path, supplier SKU, percent): tabular, no spellcheck. */
  code?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal';
  /** A unit shown inside the field on the right (`%`). */
  suffix?: string;
  disabled?: boolean;
  maxLength?: number;
}

const FIELD =
  'w-full min-w-0 rounded-[9px] border-[1.5px] bg-input px-2.5 text-[13px] text-foreground focus:border-ring focus:ring-[3px] focus:ring-primary-soft focus:outline-none disabled:opacity-55';

/**
 * A labelled text field of the catalog editors (AdminOps.dc.html `product`: 36px, 9px radius,
 * 11/14 extrabold label in the secondary colour). The error line is text, never colour alone.
 */
export function FormField({
  label,
  value,
  onChange,
  onBlur,
  hint,
  error = null,
  multiline = false,
  code = false,
  inputMode = 'text',
  suffix,
  disabled,
  maxLength,
}: Props) {
  const id = useId();
  const note = error ?? hint ?? null;
  const shared = {
    id,
    value,
    onBlur,
    disabled,
    maxLength,
    spellCheck: !code,
    'aria-invalid': error !== null,
    'aria-describedby': note === null ? undefined : `${id}-note`,
    className: cn(
      FIELD,
      error === null ? 'border-input-border' : 'border-danger',
      code ? 'font-mono font-bold tabular-nums' : 'font-semibold',
    ),
  };
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      <label
        htmlFor={id}
        className="text-[11px] leading-[14px] font-extrabold text-foreground-secondary"
      >
        {label}
      </label>
      <div className="relative flex">
        {multiline ? (
          <textarea
            {...shared}
            rows={3}
            onChange={(event) => onChange(event.target.value)}
            className={cn(shared.className, 'resize-y py-2 leading-[19px]')}
          />
        ) : (
          <input
            {...shared}
            inputMode={inputMode}
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
            className={cn(shared.className, 'h-9', suffix ? 'pr-8' : undefined)}
          />
        )}
        {suffix ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 right-2.5 bottom-0 flex items-center text-[13px] font-extrabold text-foreground-muted"
          >
            {suffix}
          </span>
        ) : null}
      </div>
      {note === null ? null : (
        <span
          id={`${id}-note`}
          className={cn(
            'text-[11px] leading-[15px] font-semibold',
            error === null ? 'text-foreground-muted' : 'text-danger-text',
          )}
        >
          {note}
        </span>
      )}
    </div>
  );
}
