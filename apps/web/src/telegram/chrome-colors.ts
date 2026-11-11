import { callSdk, type TelegramWebApp } from './webapp';

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Paints Telegram's header, page background and bottom bar with our `--background` token, so the
 * Mini App has no strip of Telegram's own colour around it (Q11). The token is read from the
 * computed style, which already reflects the current data-theme. `setHeaderColor` and
 * `setBackgroundColor` need Bot API 6.1, `setBottomBarColor` 7.10; older clients are skipped.
 */
export function paintTelegramChrome(app: TelegramWebApp, root: HTMLElement): void {
  const color = getComputedStyle(root).getPropertyValue('--background').trim();
  if (!HEX.test(color)) return;
  callSdk(() => app.setHeaderColor(color));
  callSdk(() => app.setBackgroundColor(color));
  callSdk(() => app.setBottomBarColor?.(color));
}
