'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { getNavDepth, installNavDepth } from './nav-depth';
import { useTelegram } from './telegram-context';
import { useBackButton, useHasBackHandler } from './use-back-button';

const MINI_APP_ROOT = '/tg';

/**
 * Renders nothing; mounts the native BackButton for the Mini App's screens. It is visible on every
 * screen below the home page, and also on the home page while an overlay (a sheet) is open, so
 * the sheet can be closed with it. Pressed, it goes back inside the app; when the app has no
 * earlier screen of its own to return to (a screen opened by a deep link, or reached by going back
 * to one), it goes to the home page instead of doing nothing or leaving the Mini App.
 *
 * "Earlier screen of its own" is counted by nav-depth.ts, not read from `history.length`.
 *
 * Mounted by TgGate only once there is a session: the splash and the gate screens have no back.
 */
export function TelegramBackButton() {
  const { webApp } = useTelegram();
  const pathname = usePathname();
  const router = useRouter();
  const overlayOpen = useHasBackHandler();
  useEffect(() => installNavDepth(), []);
  const goBack = useCallback(() => {
    if (getNavDepth() > 0) router.back();
    else router.replace(MINI_APP_ROOT);
  }, [router]);
  const nested = pathname.startsWith(`${MINI_APP_ROOT}/`);
  useBackButton(webApp, nested || overlayOpen, goBack);
  return null;
}
