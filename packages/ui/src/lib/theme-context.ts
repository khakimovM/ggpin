'use client';

import { createContext, useContext } from 'react';

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';

export interface ThemeContextValue {
  variant: 'telegram' | 'web';
  /** The theme actually applied to <html data-theme>. */
  theme: ThemeName;
  /** What the user chose; `system` follows the OS (web only). */
  preference: ThemePreference;
  /** No-op in the Telegram variant: Telegram owns the colour scheme there. */
  setPreference: (next: ThemePreference) => void;
  reducedMotion: boolean;
  setReducedMotion: (next: boolean) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}
