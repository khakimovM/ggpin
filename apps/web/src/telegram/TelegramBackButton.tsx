'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { getNavDepth, installNavDepth } from './nav-depth';
import { useTelegram } from './telegram-context';
import { useBackButton, useHasBackHandler } from './use-back-button';

const MINI_APP_ROOT = '/tg';
// The three roots of the app (home, history, profile) have the tab bar instead of a way back:
// Telegram shows "Close" there.
const TAB_ROOTS: ReadonlySet<string> = new Set([
  MINI_APP_ROOT,
  `${MINI_APP_ROOT}/history`,
  `${MINI_APP_ROOT}/profile`,
]);
// A screen opened by a deep link has no earlier screen of the app to go back to; these two belong
// to the profile, so Back leads there and not to the home page.
const PARENT: Readonly<Record<string, string>> = {
  [`${MINI_APP_ROOT}/referral`]: `${MINI_APP_ROOT}/profile`,
  [`${MINI_APP_ROOT}/help`]: `${MINI_APP_ROOT}/profile`,
};

/**
 * Renders nothing; mounts the native BackButton for the Mini App's screens. It is visible on every
 * screen below the home page, and also on the home page while an overlay (a sheet) is open, so
 * the sheet can be closed with it. Pressed, it goes back inside the app; when the app has no
 * earlier screen of its own to return to (a screen opened by a deep link, or reached by going back
 * to one), it goes to the screen's parent (the profile for referral and help) or the home page,
 * instead of doing nothing or leaving the Mini App.
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
    else router.replace(PARENT[pathname] ?? MINI_APP_ROOT);
  }, [router, pathname]);
  const nested = pathname.startsWith(`${MINI_APP_ROOT}/`) && !TAB_ROOTS.has(pathname);
  useBackButton(webApp, nested || overlayOpen, goBack);
  return null;
}
