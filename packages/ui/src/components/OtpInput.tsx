'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';
import { useReducedMotion } from '../lib/motion';
import { FIELD_FOCUS } from '../lib/styles';

export interface OtpInputProps {
  /** Digits entered so far, 0..length characters. */
  value: string;
  onChange: (value: string) => void;
  /** Fires once each time the code becomes complete (typing the last digit or pasting all). */
  onComplete?: (code: string) => void;
  length?: number;
  /** Wrong code: red boxes and a shake (the shake is skipped under reduced motion). */
  error?: boolean;
  /**
   * Bump this on every failed attempt: the shake plays again even when `error` stayed true
   * (two wrong codes in a row).
   */
  errorKey?: number;
  /** Text under the boxes while `error` is set; it is wired to every box by aria-describedby. */
  errorMessage?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Accessible name of the group, e.g. "Tasdiqlash kodi". */
  label: string;
  /** Accessible name of one box, e.g. (1, 6) => "Kod, 1-raqam". */
  boxLabel: (position: number, total: number) => string;
}

const digitsOnly = (raw: string) => raw.replace(/\D/g, '');

// The gg-shake keyframes of tokens.css, for Web Animations (so it can be replayed on demand).
const SHAKE_FRAMES = [
  { transform: 'none' },
  { transform: 'translateX(-5px)', offset: 0.2 },
  { transform: 'translateX(5px)', offset: 0.4 },
  { transform: 'translateX(-5px)', offset: 0.6 },
  { transform: 'translateX(5px)', offset: 0.8 },
  { transform: 'none' },
];

export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  error = false,
  errorKey = 0,
  errorMessage,
  disabled = false,
  autoFocus = false,
  label,
  boxLabel,
}: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const groupRef = useRef<HTMLDivElement>(null);
  const messageId = useId();
  const reduced = useReducedMotion();
  const describedBy = error && errorMessage ? messageId : undefined;

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const group = groupRef.current;
    if (error && !reduced && group && typeof group.animate === 'function') {
      group.animate(SHAKE_FRAMES, { duration: 320, easing: 'cubic-bezier(.2,0,0,1)' });
    }
  }, [error, errorKey, reduced]);

  const focusBox = (index: number) =>
    refs.current[Math.max(0, Math.min(length - 1, index))]?.focus();

  const commit = (next: string, focusIndex: number) => {
    const code = next.slice(0, length);
    onChange(code);
    focusBox(focusIndex);
    // A code that was already complete and is edited again counts as a new completion.
    if (code.length === length && code !== value) onComplete?.(code);
  };

  // Typing, an OS one-time-code autofill (whole code into one box) and paste all arrive here.
  const insertAt = (index: number, raw: string) => {
    const incoming = digitsOnly(raw);
    if (!incoming) return;
    // Entering a digit never leaves a gap: it lands at the end of what has been typed.
    const start = Math.min(index, value.length);
    const next = value.slice(0, start) + incoming + value.slice(start + incoming.length);
    commit(next, start + incoming.length);
  };

  const removeAt = (index: number) => onChange(value.slice(0, index) + value.slice(index + 1));

  const backspaceInEmptyBox = (index: number) => {
    if (index > 0) {
      removeAt(index - 1);
      focusBox(index - 1);
    }
  };

  // Soft keyboards (Android) send Backspace as a beforeinput event instead of a key; in an empty
  // box nothing changes, so no change event follows either. Native listener: React does not
  // surface beforeinput deletions. The latest handler is read through a ref.
  const latest = useRef(backspaceInEmptyBox);
  useLayoutEffect(() => {
    latest.current = backspaceInEmptyBox;
  });
  useEffect(() => {
    const boxes = refs.current.slice(0, length);
    const cleanups = boxes.map((box, index) => {
      if (!box) return () => undefined;
      const listener = (event: InputEvent) => {
        if (event.inputType === 'deleteContentBackward' && box.value === '') {
          event.preventDefault();
          latest.current(index);
        }
      };
      box.addEventListener('beforeinput', listener);
      return () => box.removeEventListener('beforeinput', listener);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [length]);

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    insertAt(0, event.clipboardData.getData('text'));
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (value[index]) removeAt(index);
      else backspaceInEmptyBox(index);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(index + 1);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={groupRef}
        role="group"
        aria-label={label}
        onPaste={onPaste}
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }}
      >
        {Array.from({ length }, (_, index) => {
          const digit = value[index] ?? '';
          return (
            <input
              key={index}
              ref={(node) => {
                refs.current[index] = node;
              }}
              value={digit}
              disabled={disabled}
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              aria-label={boxLabel(index + 1, length)}
              aria-invalid={error || undefined}
              aria-describedby={describedBy}
              onChange={(event) => {
                const raw = event.target.value;
                // Cleared from the box itself (cut, select + delete, IME): drop that digit.
                if (raw === '') {
                  if (digit) removeAt(index);
                  return;
                }
                // A box that already holds a digit receives two characters when the old one was
                // not selected (touch keyboards); keep only the new one.
                insertAt(index, digit && raw.length === 2 ? raw.replace(digit, '') : raw);
              }}
              onKeyDown={onKeyDown(index)}
              onFocus={(event) => event.target.select()}
              className={cn(
                'h-[60px] w-full min-w-0 rounded-md border-[1.5px] bg-input text-center',
                'font-display text-2xl leading-none font-bold text-foreground tabular-nums',
                'transition duration-fast ease-standard',
                error
                  ? 'border-danger bg-danger-soft'
                  : digit
                    ? 'border-foreground-muted'
                    : 'border-input-border',
                FIELD_FOCUS,
                disabled && 'opacity-50',
              )}
            />
          );
        })}
      </div>
      {error && errorMessage ? (
        <p
          id={messageId}
          role="alert"
          className="text-center text-[13px] leading-[18px] font-bold text-danger-text"
        >
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
