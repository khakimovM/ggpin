'use client';

import { CircleX } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';
import { FIELD_FOCUS } from '../lib/styles';
import { Chip } from './Chip';
import { Icon } from './Icon';

export interface QuickAmount {
  /** Amount in whole so'm, digits only, e.g. "50000". */
  value: string;
  label: string;
}

export interface MoneyInputProps {
  label: string;
  /** Whole so'm as digits only, e.g. "150000"; "" when empty. */
  value: string;
  /** Receives digits only (max `maxDigits`). The caller converts to tiyin with somToTiyin. */
  onValueChange: (digits: string) => void;
  /** Currency word shown inside the field, e.g. "so‘m". */
  unit: string;
  help?: ReactNode;
  /** Inclusive limits in whole so'm; the error texts are shown once the field has a value. */
  min?: string;
  max?: string;
  minError?: string;
  maxError?: string;
  /** Chips that add to the current amount. */
  quickAmounts?: QuickAmount[];
  maxDigits?: number;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

// Thousands separator of formatMoney (narrow no-break space), so the input and the totals match.
const GROUP = ' ';

export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+$)/g, GROUP);
}

/**
 * Turns whatever was typed or pasted into whole so'm digits (all of them: the caller decides
 * what a too long number means, nothing is cut here).
 *
 * The trailing unit ("so‘m", "сум", "UZS") is dropped first. Then the LAST "," or "." decides:
 * followed by 1-2 digits it is a decimal point and the fraction is dropped ("37 050,50",
 * "150000.00", "1.000,50", "10,000.50"), because gluing it on would make the amount 10-100x
 * larger. Followed by 3 digits it is a thousands separator ("1.000", "1,000,000").
 */
export function parseSom(raw: string): string {
  const trimmed = raw.replace(/\D+$/u, '');
  const last = Math.max(trimmed.lastIndexOf(','), trimmed.lastIndexOf('.'));
  const whole =
    last >= 0 && /^\d{1,2}$/.test(trimmed.slice(last + 1)) ? trimmed.slice(0, last) : trimmed;
  return whole.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

const countDigits = (text: string) => text.replace(/\D/g, '').length;

// Index right after the n-th digit of the formatted text (0 when n is 0).
function caretAfterDigits(formatted: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted.charAt(index))) seen += 1;
    if (seen === n) return index + 1;
  }
  return formatted.length;
}

// Limits compare as BigInt: digit strings never pass through floating point.
function outOfRange(value: string, min?: string, max?: string): 'min' | 'max' | null {
  if (!value) return null;
  const amount = BigInt(value);
  if (min && amount < BigInt(min)) return 'min';
  if (max && amount > BigInt(max)) return 'max';
  return null;
}

export function MoneyInput({
  label,
  value,
  onValueChange,
  unit,
  help,
  min,
  max,
  minError,
  maxError,
  quickAmounts,
  maxDigits = 9,
  placeholder = '0',
  disabled,
  id,
}: MoneyInputProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const messageId = `${fieldId}-message`;
  const violation = outOfRange(value, min, max);
  const error = violation === 'min' ? minError : violation === 'max' ? maxError : undefined;
  const message = error ?? help;

  const inputRef = useRef<HTMLInputElement>(null);
  // Caret position as "how many digits are left of it": it survives re-grouping, a character
  // index would not ("1 2|34" -> typing grows the text and shifts every separator).
  const pendingCaret = useRef<number | null>(null);

  const placeCaret = () => {
    const input = inputRef.current;
    const digits = pendingCaret.current;
    if (!input || digits === null) return;
    pendingCaret.current = null;
    if (document.activeElement !== input) return;
    const at = caretAfterDigits(input.value, digits);
    input.setSelectionRange(at, at);
  };
  // After every render: React rewrites the DOM value and moves the caret to the end.
  useLayoutEffect(placeCaret);

  // The restore is always scheduled. When the parent takes the new value it re-renders and the
  // layout effect uses (and clears) the pending caret, so the microtask finds nothing to do.
  // When nothing re-renders (the parent refused, or the digits did not change, e.g. a rejected
  // letter) the pending caret is still set: it is replaced by the caret from before the edit and
  // applied once React has restored the controlled value. No stale caret survives either way.
  const commit = (next: string, caretDigits: number, caretBeforeEdit: number) => {
    pendingCaret.current = Math.min(caretDigits, next.length);
    onValueChange(next);
    queueMicrotask(() => {
      if (pendingCaret.current !== null) pendingCaret.current = caretBeforeEdit;
      placeCaret();
    });
  };

  // The edit would make the number longer than maxDigits: keep the old amount (never cut off the
  // last digit) and leave the caret where it was before the edit.
  const refuse = (caretDigits: number) => {
    pendingCaret.current = caretDigits;
    queueMicrotask(placeCaret);
  };

  // Backspace right after a separator, or Delete right before one, would only move the caret
  // over it. Remove the neighbouring digit instead, like a plain number field does. Returns true
  // when it took over (the native deletion must then be cancelled).
  const deleteAdjacent = (input: HTMLInputElement, direction: 'backward' | 'forward'): boolean => {
    const { selectionStart: start, selectionEnd: end } = input;
    if (start === null || start !== end) return false;
    const neighbour = input.value.charAt(direction === 'backward' ? start - 1 : start);
    if (neighbour === '' || /\d/.test(neighbour)) return false;
    const before = countDigits(input.value.slice(0, start));
    if (direction === 'backward') {
      if (before > 0)
        commit(parseSom(value.slice(0, before - 1) + value.slice(before)), before - 1, before);
    } else if (before < value.length) {
      commit(parseSom(value.slice(0, before) + value.slice(before + 1)), before, before);
    }
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const direction =
      event.key === 'Backspace' ? 'backward' : event.key === 'Delete' ? 'forward' : null;
    if (direction && deleteAdjacent(event.currentTarget, direction)) event.preventDefault();
  };

  // Soft keyboards (Android) report Backspace as key "Unidentified" and only send beforeinput;
  // React does not surface deletions from it, so this is a native listener that reads the latest
  // handler through a ref.
  const latestDelete = useRef(deleteAdjacent);
  useLayoutEffect(() => {
    latestDelete.current = deleteAdjacent;
  });
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const listener = (event: InputEvent) => {
      if (event.isComposing) return;
      const direction =
        event.inputType === 'deleteContentBackward'
          ? 'backward'
          : event.inputType === 'deleteContentForward'
            ? 'forward'
            : null;
      if (direction && latestDelete.current(input, direction)) event.preventDefault();
    };
    input.addEventListener('beforeinput', listener);
    return () => input.removeEventListener('beforeinput', listener);
  }, []);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-[13px] leading-[18px] font-bold">
          {label}
        </label>
        <div className="relative flex">
          <input
            ref={inputRef}
            id={fieldId}
            inputMode="numeric"
            autoComplete="off"
            value={groupDigits(value)}
            placeholder={placeholder}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={message ? messageId : undefined}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              const text = event.target.value;
              const caret = event.target.selectionStart ?? text.length;
              const next = parseSom(text);
              const caretDigits = countDigits(text.slice(0, caret));
              // before this edit the caret stood left of the digits that were just added
              const caretBeforeEdit = Math.max(0, caretDigits - (countDigits(text) - value.length));
              if (next.length > maxDigits) {
                refuse(caretBeforeEdit);
                return;
              }
              commit(next, caretDigits, caretBeforeEdit);
            }}
            className={cn(
              'h-[60px] min-w-0 flex-1 rounded-md border-[1.5px] border-input-border bg-input pr-16 pl-4',
              'font-display text-2xl leading-none font-semibold tracking-[-.02em] text-foreground tabular-nums',
              'transition duration-fast ease-standard',
              error && 'border-danger',
              FIELD_FOCUS,
              error && 'focus:border-danger focus:ring-danger-soft',
              disabled && 'opacity-55',
            )}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[15px] font-bold text-foreground-muted"
          >
            {unit}
          </span>
        </div>
        {message ? (
          <span
            id={messageId}
            role={error ? 'alert' : undefined}
            className={cn(
              'flex items-center gap-1.5 text-xs leading-4',
              error ? 'font-semibold text-danger-text' : 'font-medium text-foreground-muted',
            )}
          >
            {error ? <Icon icon={CircleX} size={13} className="shrink-0" /> : null}
            <span className="min-w-0">{message}</span>
          </span>
        ) : null}
      </div>
      {quickAmounts?.length ? (
        <div className="flex flex-wrap gap-2">
          {quickAmounts.map((quick) => (
            <Chip
              key={quick.value}
              variant="quick"
              disabled={disabled}
              onClick={() => {
                const sum = (BigInt(value || '0') + BigInt(quick.value)).toString();
                // Past the digit limit the amount is capped, never cut (that would change it
                // by orders of magnitude).
                onValueChange(sum.length > maxDigits ? '9'.repeat(maxDigits) : sum);
              }}
            >
              {quick.label}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
