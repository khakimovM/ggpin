'use client';

import { createContext, useContext } from 'react';
import type { TelegramWebApp } from './webapp';

/**
 * - `detecting`: server render and first client render; nothing is known yet.
 * - `telegram`: running inside Telegram, with a signed initData.
 * - `browser`: no Telegram (a plain browser, or the SDK failed to load).
 */
export type TelegramPhase = 'detecting' | 'telegram' | 'browser';

export interface TelegramContextValue {
  phase: TelegramPhase;
  webApp: TelegramWebApp | null;
}

export const TelegramContext = createContext<TelegramContextValue>({
  phase: 'detecting',
  webApp: null,
});

export function useTelegram(): TelegramContextValue {
  return useContext(TelegramContext);
}
