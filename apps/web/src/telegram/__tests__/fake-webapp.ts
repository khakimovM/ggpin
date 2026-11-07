import { vi } from 'vitest';
import type { TelegramEvent, TelegramInset, TelegramWebApp } from '../webapp';

// A WebApp double for unit tests: every method is a spy, events can be fired by hand, and
// colorScheme / insets can be changed like Telegram does before it fires the event.
export interface FakeWebApp extends TelegramWebApp {
  colorScheme: 'light' | 'dark';
  safeAreaInset?: TelegramInset;
  contentSafeAreaInset?: TelegramInset;
  fire: (event: TelegramEvent) => void;
  pressMain: () => void;
  pressBack: () => void;
}

export const TEST_INIT_DATA = 'query_id=AAHtest&auth_date=1730000000&hash=00ff';

export function createFakeWebApp(
  options: { initData?: string; colorScheme?: 'light' | 'dark'; languageCode?: string } = {},
): FakeWebApp {
  const listeners = new Map<TelegramEvent, Set<() => void>>();
  const mainHandlers: (() => void)[] = [];
  const backHandlers: (() => void)[] = [];
  const remove = (list: (() => void)[], callback: () => void) => {
    const index = list.indexOf(callback);
    if (index >= 0) list.splice(index, 1);
  };
  return {
    initData: options.initData ?? TEST_INIT_DATA,
    initDataUnsafe: { user: { language_code: options.languageCode ?? 'uz' } },
    colorScheme: options.colorScheme ?? 'light',
    ready: vi.fn(),
    expand: vi.fn(),
    close: vi.fn(),
    isVersionAtLeast: vi.fn(() => true),
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBottomBarColor: vi.fn(),
    onEvent: vi.fn((event: TelegramEvent, callback: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(callback);
      listeners.set(event, set);
    }),
    offEvent: vi.fn((event: TelegramEvent, callback: () => void) => {
      listeners.get(event)?.delete(callback);
    }),
    openLink: vi.fn(),
    openTelegramLink: vi.fn(),
    BackButton: {
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn((callback: () => void) => void backHandlers.push(callback)),
      offClick: vi.fn((callback: () => void) => remove(backHandlers, callback)),
    },
    MainButton: {
      setText: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      showProgress: vi.fn(),
      hideProgress: vi.fn(),
      onClick: vi.fn((callback: () => void) => void mainHandlers.push(callback)),
      offClick: vi.fn((callback: () => void) => remove(mainHandlers, callback)),
    },
    HapticFeedback: {
      impactOccurred: vi.fn(),
      notificationOccurred: vi.fn(),
      selectionChanged: vi.fn(),
    },
    fire: (event) => listeners.get(event)?.forEach((callback) => callback()),
    pressMain: () => [...mainHandlers].forEach((callback) => callback()),
    pressBack: () => [...backHandlers].forEach((callback) => callback()),
  };
}

/** Installs the double as `window.Telegram.WebApp`; the returned function removes it. */
export function installWebApp(app: TelegramWebApp): () => void {
  window.Telegram = { WebApp: app };
  return () => {
    delete window.Telegram;
  };
}
