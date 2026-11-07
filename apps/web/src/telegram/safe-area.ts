import type { TelegramInset, TelegramWebApp } from './webapp';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

const px = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * CSS variables for the room Telegram's own interface takes: `--tg-safe-{top,right,bottom,left}`.
 * Each is the device safe area plus the content safe area (the strip under Telegram's header
 * buttons in fullscreen), because screens need the sum to keep clear of both. Clients older than
 * Bot API 8.0 report neither, and every variable is then 0px.
 */
export function safeAreaVars(
  app: Pick<TelegramWebApp, 'safeAreaInset' | 'contentSafeAreaInset'>,
): Record<string, string> {
  const device: Partial<TelegramInset> = app.safeAreaInset ?? {};
  const content: Partial<TelegramInset> = app.contentSafeAreaInset ?? {};
  return Object.fromEntries(
    SIDES.map((side) => [`--tg-safe-${side}`, `${px(device[side]) + px(content[side])}px`]),
  );
}

export function applySafeArea(
  element: HTMLElement,
  app: Pick<TelegramWebApp, 'safeAreaInset' | 'contentSafeAreaInset'>,
): void {
  for (const [name, value] of Object.entries(safeAreaVars(app))) {
    element.style.setProperty(name, value);
  }
}
