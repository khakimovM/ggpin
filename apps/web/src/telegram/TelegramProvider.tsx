'use client';

import { localeFromTelegram } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useTgUiStore } from '../stores/tg-ui-store';
import { paintTelegramChrome } from './chrome-colors';
import { applySafeArea } from './safe-area';
import { TelegramContext, type TelegramPhase } from './telegram-context';
import { callSdk, getWebApp, type TelegramColorScheme } from './webapp';

// useLayoutEffect warns during SSR; the effect below only touches the client anyway.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// The SDK object is an external system, so it is read through useSyncExternalStore: the server and
// the hydration pass see `detecting` / light, and the real values arrive right after, before paint.
const noSubscription = () => () => undefined;

const DARK_QUERY = '(prefers-color-scheme: dark)';
const osMedia = () =>
  typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;

// Inside Telegram the client decides (`themeChanged`); outside it (the bot gate of a plain
// browser) there is no Telegram scheme, so the OS setting decides.
function subscribeTheme(onChange: () => void): () => void {
  const app = getWebApp();
  if (!app) {
    const media = osMedia();
    media?.addEventListener('change', onChange);
    return () => media?.removeEventListener('change', onChange);
  }
  app.onEvent('themeChanged', onChange);
  return () => app.offEvent('themeChanged', onChange);
}

const phaseSnapshot = (): TelegramPhase => (getWebApp() ? 'telegram' : 'browser');
const schemeSnapshot = (): TelegramColorScheme => {
  const app = getWebApp();
  const dark = app ? app.colorScheme === 'dark' : (osMedia()?.matches ?? false);
  return dark ? 'dark' : 'light';
};

/**
 * Connects the page to the Telegram client: tells it the app is ready and expands it, follows its
 * colour scheme (`themeChanged`), paints its header and background with our token, and mirrors its
 * safe-area insets into CSS variables (`safeAreaChanged`). Outside Telegram it only reports that
 * (`phase: 'browser'`) so the gate can say so.
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  const phase = useSyncExternalStore(noSubscription, phaseSnapshot, () => 'detecting' as const);
  const colorScheme = useSyncExternalStore(subscribeTheme, schemeSnapshot, () => 'light' as const);
  const webApp = phase === 'telegram' ? getWebApp() : null;
  const setLocale = useTgUiStore((state) => state.setLocale);

  useIsoLayoutEffect(() => {
    if (phase === 'browser') {
      // Only the language of the gate text, never anything about the visitor's access.
      setLocale(localeFromTelegram(navigator.language));
      return;
    }
    if (!webApp) return;
    callSdk(() => webApp.ready());
    callSdk(() => webApp.expand());
    // A first guess for the language; the profile's locale replaces it after sign-in.
    setLocale(localeFromTelegram(webApp.initDataUnsafe.user?.language_code));
  }, [phase, webApp, setLocale]);

  useIsoLayoutEffect(() => {
    if (!webApp) return;
    const root = document.documentElement;
    const onSafeArea = () => applySafeArea(root, webApp);
    onSafeArea();
    webApp.onEvent('safeAreaChanged', onSafeArea);
    webApp.onEvent('contentSafeAreaChanged', onSafeArea);
    return () => {
      webApp.offEvent('safeAreaChanged', onSafeArea);
      webApp.offEvent('contentSafeAreaChanged', onSafeArea);
    };
  }, [webApp]);

  // Passive effect: it runs after the ThemeProvider has written data-theme for this colour scheme,
  // so the computed --background is the one of the theme now showing.
  useEffect(() => {
    if (webApp) paintTelegramChrome(webApp, document.documentElement);
  }, [webApp, colorScheme]);

  const context = useMemo(() => ({ phase, webApp }), [phase, webApp]);
  return (
    <TelegramContext.Provider value={context}>
      <ThemeProvider variant="telegram" colorScheme={colorScheme}>
        {children}
      </ThemeProvider>
    </TelegramContext.Provider>
  );
}
