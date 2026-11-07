// A typed view of `window.Telegram.WebApp` (https://core.telegram.org/bots/webapps): only the
// members this app uses. The SDK script is loaded by app/tg/layout.tsx; outside Telegram it still
// defines the object, but with an empty initData, which is how the app tells the two apart.

export type TelegramColorScheme = 'light' | 'dark';

export interface TelegramInset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type TelegramEvent =
  'themeChanged' | 'safeAreaChanged' | 'contentSafeAreaChanged' | 'viewportChanged';

export interface TelegramBackButton {
  show: () => void;
  hide: () => void;
  onClick: (callback: () => void) => void;
  offClick: (callback: () => void) => void;
}

export interface TelegramMainButton {
  setText: (text: string) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  onClick: (callback: () => void) => void;
  offClick: (callback: () => void) => void;
}

export type HapticImpact = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
export type HapticNotification = 'error' | 'success' | 'warning';

export interface TelegramHaptics {
  impactOccurred: (style: HapticImpact) => void;
  notificationOccurred: (type: HapticNotification) => void;
  selectionChanged: () => void;
}

export interface TelegramWebApp {
  /** Signed launch parameters. Secret: sent to the API in one request body, never logged. */
  readonly initData: string;
  /** Unsigned and untrusted: good for the first guess of a language, never for access. */
  readonly initDataUnsafe: { user?: { language_code?: string } };
  readonly colorScheme: TelegramColorScheme;
  /** Bot API 8.0+. */
  readonly safeAreaInset?: TelegramInset;
  readonly contentSafeAreaInset?: TelegramInset;
  ready: () => void;
  expand: () => void;
  close: () => void;
  isVersionAtLeast: (version: string) => boolean;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  onEvent: (event: TelegramEvent, callback: () => void) => void;
  offEvent: (event: TelegramEvent, callback: () => void) => void;
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink: (url: string) => void;
  readonly BackButton: TelegramBackButton;
  readonly MainButton: TelegramMainButton;
  readonly HapticFeedback: TelegramHaptics;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/**
 * The WebApp object when this page runs inside Telegram, otherwise null: on the server, in a
 * plain browser (the SDK defines an object with no initData there), or when the SDK failed to
 * load. Cheap, so callers read it fresh instead of caching it.
 */
export function getWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  const app = window.Telegram?.WebApp;
  if (!app || typeof app.initData !== 'string' || app.initData === '') return null;
  if (typeof app.ready !== 'function') return null;
  return app;
}

/** The raw initData, or null outside Telegram. Read at call time, never stored by us. */
export function readInitData(): string | null {
  return getWebApp()?.initData ?? null;
}

/**
 * Calls an SDK method that older clients lack. They throw (or log) `WebAppMethodUnsupported`;
 * a missing nicety such as a header colour must never break the app, so it is swallowed.
 */
export function callSdk(action: () => void): void {
  try {
    action();
  } catch {
    // Unsupported on this client version.
  }
}
