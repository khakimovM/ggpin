'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE, REDUCED_FADE, useReducedMotion } from '../lib/motion';
import { ToastContext, type ToastApi, type ToastOptions } from '../lib/toast-context';
import { Toast } from './Toast';

export interface ToastProviderProps {
  children: ReactNode;
  /**
   * top: Mini App (clear of the native MainButton). bottom-end: web; on small screens it spans
   * the width above the bottom edge (raise it with --toast-offset when a nav bar is there).
   */
  placement?: 'top' | 'bottom-end';
  /** Accessible name of every toast's close button. */
  closeLabel: string;
}

interface Entry extends ToastOptions {
  id: string;
}

// Errors stay longer: they usually say what to do next and are read more slowly.
const DEFAULT_DURATION_MS = 4000;
const ERROR_DURATION_MS = 8000;
const MAX_VISIBLE = 3;

interface Countdown {
  handle: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}

export function ToastProvider({
  children,
  placement = 'bottom-end',
  closeLabel,
}: ToastProviderProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const countdowns = useRef(new Map<string, Countdown>());
  const counter = useRef(0);
  const reduced = useReducedMotion();

  const dismiss = useCallback((id: string) => {
    const countdown = countdowns.current.get(id);
    if (countdown?.handle) clearTimeout(countdown.handle);
    countdowns.current.delete(id);
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const start = useCallback(
    (id: string, milliseconds: number) => {
      countdowns.current.set(id, {
        handle: setTimeout(() => dismiss(id), milliseconds),
        remaining: milliseconds,
        startedAt: Date.now(),
      });
    },
    [dismiss],
  );

  // Hovering or focusing a toast stops its clock, so it cannot vanish while being read or while
  // the close button is being reached with the keyboard; leaving resumes with the time left.
  const pause = useCallback((id: string) => {
    const countdown = countdowns.current.get(id);
    if (!countdown?.handle) return;
    clearTimeout(countdown.handle);
    countdown.handle = null;
    countdown.remaining = Math.max(0, countdown.remaining - (Date.now() - countdown.startedAt));
  }, []);

  const resume = useCallback(
    (id: string) => {
      const countdown = countdowns.current.get(id);
      if (countdown && !countdown.handle) start(id, countdown.remaining);
    },
    [start],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      setEntries((current) => [...current, { ...options, id }].slice(-MAX_VISIBLE));
      start(
        id,
        options.duration ?? (options.tone === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS),
      );
      return id;
    },
    [start],
  );

  // A toast pushed out by newer ones (more than MAX_VISIBLE) leaves the list without ever being
  // dismissed: stop its clock too, or it would keep a timer alive for nothing.
  useEffect(() => {
    countdowns.current.forEach((countdown, id) => {
      if (entries.some((entry) => entry.id === id)) return;
      if (countdown.handle) clearTimeout(countdown.handle);
      countdowns.current.delete(id);
    });
  }, [entries]);

  useEffect(() => {
    const pending = countdowns.current;
    return () => {
      pending.forEach((countdown) => {
        if (countdown.handle) clearTimeout(countdown.handle);
      });
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  const fromTop = placement === 'top';

  const renderEntry = (entry: Entry) => (
    <motion.div
      key={entry.id}
      layout={!reduced}
      initial={{ opacity: 0, y: reduced ? 0 : fromTop ? -12 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={reduced ? REDUCED_FADE : { duration: DURATION.base, ease: EASE.out }}
      className="pointer-events-auto"
      // Mouse only: a tap on a touch screen also fires emulated hover events that never get a
      // matching leave, which would freeze the toast on screen for good.
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') pause(entry.id);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') resume(entry.id);
      }}
      onFocus={() => pause(entry.id)}
      onBlur={() => resume(entry.id)}
    >
      <Toast
        tone={entry.tone}
        title={entry.title}
        description={entry.description}
        closeLabel={closeLabel}
        onClose={() => dismiss(entry.id)}
      />
    </motion.div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* The only live mechanism: two persistent regions, polite for everything and assertive
          for errors. The toast cards inside carry no role, so nothing is announced twice. */}
      <div
        className={cn(
          'pointer-events-none fixed z-[60] flex flex-col gap-2',
          fromTop
            ? 'inset-x-4 top-[calc(12px+max(env(safe-area-inset-top),var(--tg-safe-top,0px)))] md:inset-x-auto md:right-6 md:w-[380px]'
            : 'inset-x-4 bottom-[calc(16px+var(--toast-offset,0px)+env(safe-area-inset-bottom))] md:inset-x-auto md:right-6 md:bottom-6 md:w-[380px]',
          !fromTop && 'flex-col-reverse',
        )}
      >
        <div aria-live="polite" className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {entries.filter((entry) => entry.tone !== 'error').map(renderEntry)}
          </AnimatePresence>
        </div>
        <div aria-live="assertive" className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {entries.filter((entry) => entry.tone === 'error').map(renderEntry)}
          </AnimatePresence>
        </div>
      </div>
    </ToastContext.Provider>
  );
}
