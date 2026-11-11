'use client';

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { hasBackHandler, pushBackHandler, runBackHandler, subscribeBackStack } from './back-stack';
import { callSdk, type TelegramWebApp } from './webapp';

/**
 * Shows the native BackButton while `visible` and runs `onBack` when it is pressed, unless an
 * overlay registered a handler first (see useBackInterceptor): then the overlay closes instead.
 * Hides the button again when the screen goes away.
 */
export function useBackButton(
  webApp: TelegramWebApp | null,
  visible: boolean,
  onBack: () => void,
): void {
  const latest = useRef(onBack);
  useLayoutEffect(() => {
    latest.current = onBack;
  });

  useEffect(() => {
    if (!webApp || !visible) return;
    const press = () => {
      if (!runBackHandler()) latest.current();
    };
    const button = webApp.BackButton;
    callSdk(() => button.show());
    button.onClick(press);
    return () => {
      button.offClick(press);
      callSdk(() => button.hide());
    };
  }, [webApp, visible]);
}

/**
 * While `active` (a sheet is open), the BackButton calls `onBack` (close the sheet) before it
 * navigates anywhere. The handler is read through a ref, so an inline callback does not re-push on
 * every render: the entry is pushed when `active` turns on and removed when it turns off, which
 * keeps the order of nested overlays.
 */
export function useBackInterceptor(active: boolean, onBack: () => void): void {
  const latest = useRef(onBack);
  useLayoutEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => latest.current());
  }, [active]);
}

/** True while any overlay has registered a back handler (an open sheet on the home page, say). */
export function useHasBackHandler(): boolean {
  return useSyncExternalStore(subscribeBackStack, hasBackHandler, () => false);
}
