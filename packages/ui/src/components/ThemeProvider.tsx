'use client';

import { MotionConfig } from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useMediaQuery } from '../lib/motion';
import {
  ThemeContext,
  type ThemeContextValue,
  type ThemeName,
  type ThemePreference,
} from '../lib/theme-context';

export interface ThemeProviderProps {
  /**
   * telegram: the theme follows `colorScheme` (Telegram.WebApp.colorScheme), no toggle.
   * web: light / dark / system, remembered in localStorage.
   */
  variant: 'telegram' | 'web';
  /** Telegram variant only: the current Telegram colour scheme. */
  colorScheme?: ThemeName;
  /** Web variant only: used until the user picks something. */
  defaultPreference?: ThemePreference;
  /**
   * Profile switch "Animatsiyalarni kamaytirish". When given it wins over the stored choice;
   * the OS setting is always honoured on top of it.
   */
  reducedMotion?: boolean;
  onReducedMotionChange?: (next: boolean) => void;
  children: ReactNode;
}

const THEME_KEY = 'ggpin-theme';
const REDUCED_KEY = 'ggpin-reduced-motion';

// useLayoutEffect warns during SSR; the effects below only touch the document anyway.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// A tiny external store over localStorage: server and first client render read `null`, the real
// value arrives right after hydration without a setState-in-effect, and other tabs stay in sync.
const listeners = new Set<() => void>();

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage can be blocked (private mode, embedded webviews)
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // not persisted; the choice still applies for this visit
  }
  listeners.forEach((listener) => listener());
}

function subscribeStorage(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function useStored(key: string): string | null {
  return useSyncExternalStore(
    subscribeStorage,
    () => readStorage(key),
    () => null,
  );
}

function isPreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function ThemeProvider({
  variant,
  colorScheme = 'light',
  defaultPreference = 'system',
  reducedMotion,
  onReducedMotionChange,
  children,
}: ThemeProviderProps) {
  const storedTheme = useStored(THEME_KEY);
  const storedReduced = useStored(REDUCED_KEY);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');

  const preference: ThemePreference = isPreference(storedTheme) ? storedTheme : defaultPreference;
  const reduced = reducedMotion ?? storedReduced === 'true';

  const theme: ThemeName =
    variant === 'telegram'
      ? colorScheme
      : preference === 'system'
        ? systemDark
          ? 'dark'
          : 'light'
        : preference;

  // Tokens switch on <html data-theme>; portals (sheets, toasts) live outside any wrapper div.
  useIsoLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // [data-reduced="true"] in tokens.css turns off all CSS animation and transition. When the
  // switch is off the attribute is removed so the OS media query alone decides.
  useIsoLayoutEffect(() => {
    if (reduced) document.documentElement.dataset.reduced = 'true';
    else delete document.documentElement.dataset.reduced;
  }, [reduced]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      if (variant === 'web') writeStorage(THEME_KEY, next);
    },
    [variant],
  );

  const setReducedMotion = useCallback(
    (next: boolean) => {
      writeStorage(REDUCED_KEY, String(next));
      onReducedMotionChange?.(next);
    },
    [onReducedMotionChange],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ variant, theme, preference, setPreference, reducedMotion: reduced, setReducedMotion }),
    [variant, theme, preference, setPreference, reduced, setReducedMotion],
  );

  return (
    <ThemeContext.Provider value={value}>
      <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>{children}</MotionConfig>
    </ThemeContext.Provider>
  );
}
