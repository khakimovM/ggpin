'use client';

import { useSyncExternalStore } from 'react';

// Durations (seconds) and easings mirror the --dur-* / --ease-* tokens in tokens.css, for the
// places where motion needs numbers instead of CSS variables. UI motion stays <= 300 ms.
export const DURATION = {
  instant: 0.08,
  fast: 0.14,
  base: 0.22,
  slow: 0.32,
  slower: 0.48,
} as const;

export const EASE = {
  standard: [0.2, 0, 0, 1],
  out: [0.05, 0.7, 0.1, 1],
  in: [0.3, 0, 0.8, 0.15],
  spring: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

// "Patterns & springs" from the design system.
export const SPRING = {
  sheet: { type: 'spring', stiffness: 380, damping: 36 },
  selection: { type: 'spring', stiffness: 500, damping: 30 },
  success: { type: 'spring', stiffness: 260, damping: 15 },
} as const;

// Under reduced motion every transition becomes a short fade (design: "fade 120ms only").
export const REDUCED_FADE = { duration: 0.12 } as const;

/** Sheet closes when dragged further than this (px) or faster than the velocity (px/s). */
export const SHEET_DISMISS_OFFSET = 80;
export const SHEET_DISMISS_VELOCITY = 600;

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(onChange: () => void): () => void {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_QUERY) : null;
  media?.addEventListener('change', onChange);
  // Profile switch ("Animatsiyalarni kamaytirish"): ThemeProvider sets data-reduced on <html>.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-reduced'],
  });
  return () => {
    media?.removeEventListener('change', onChange);
    observer.disconnect();
  };
}

function getReducedSnapshot(): boolean {
  const os = typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_QUERY).matches;
  return os || document.documentElement.dataset.reduced === 'true';
}

/** True when the OS asks for reduced motion or the profile switch (data-reduced) is on. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, getReducedSnapshot, () => false);
}

/** Subscribes to a CSS media query; false on the server and during hydration. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
