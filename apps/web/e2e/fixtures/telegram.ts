import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';

// Test doubles for the Telegram Mini App: signed initData and a fake `Telegram.WebApp`. The real
// SDK script (https://telegram.org/js/telegram-web-app.js) is replaced by an empty one, so no
// request leaves the machine and the fake installed before the page scripts stays in charge.

/**
 * A synthetic token for tests only: it has the shape the API validates (`<id>:<secret>`) and signs
 * only data made in these tests. It is not a BotFather token and starts its secret part with a
 * letter pattern secret scanners do not treat as a Telegram token.
 */
export const E2E_BOT_TOKEN = '987654321:e2eSyntheticBotTokenNotRealXXXXXXXXXXXX';

export interface TestTelegramUser {
  id: number;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface InitDataFields {
  user: TestTelegramUser;
  /** Seconds since the epoch; default: now. */
  auth_date?: number;
  start_param?: string;
  query_id?: string;
}

/**
 * Signs launch parameters the way Telegram does (https://core.telegram.org/bots/webapps):
 * secret = HMAC_SHA256(key "WebAppData", msg bot token), hash = HMAC_SHA256(key secret, msg
 * data_check_string), where the string is every field but `hash`, sorted by key, `key=value`
 * joined by newlines. Returns the URL-encoded string `Telegram.WebApp.initData` holds.
 */
export function signInitData(fields: InitDataFields, botToken: string): string {
  const params = new Map<string, string>([
    ['auth_date', String(fields.auth_date ?? Math.floor(Date.now() / 1000))],
    ['query_id', fields.query_id ?? 'AAHe2eQuery'],
    ['user', JSON.stringify(fields.user)],
  ]);
  if (fields.start_param !== undefined) params.set('start_param', fields.start_param);

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const search = new URLSearchParams([...params.entries(), ['hash', hash]]);
  return search.toString();
}

export interface Inset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface FakeWebAppOptions {
  /** Signed launch parameters; omit for a plain browser (the SDK object with empty initData). */
  initData?: string;
  colorScheme?: 'light' | 'dark';
  languageCode?: string;
  safeArea?: Inset;
  contentSafeArea?: Inset;
}

export type TgCall = [name: string, ...args: unknown[]];

/** Routes the real SDK script to an empty one (no network, and the fake stays in charge). */
export async function stubTelegramSdk(page: Page): Promise<void> {
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
}

/**
 * Installs `window.Telegram.WebApp` before any page script runs. Every call the app makes is
 * recorded in `window.__tgCalls` (read it with `tgCalls`). Tests drive it with `tgEmit`
 * (theme / safe-area events), `tgSet` (change colorScheme or insets first), `tgPressMain` and
 * `tgPressBack`.
 */
export async function installFakeWebApp(page: Page, options: FakeWebAppOptions = {}) {
  await stubTelegramSdk(page);
  await page.addInitScript((o: FakeWebAppOptions) => {
    const zero = { top: 0, bottom: 0, left: 0, right: 0 };
    const calls: unknown[][] = [];
    const listeners: Record<string, (() => void)[]> = {};
    const mainHandlers: (() => void)[] = [];
    const backHandlers: (() => void)[] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([name, ...args]);
      };
    const removeFrom = (list: (() => void)[], callback: () => void) => {
      const index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    };

    const webApp = {
      initData: o.initData ?? '',
      initDataUnsafe: { user: { language_code: o.languageCode ?? 'uz' } },
      colorScheme: o.colorScheme ?? 'light',
      version: '8.0',
      platform: 'android',
      safeAreaInset: o.safeArea ?? zero,
      contentSafeAreaInset: o.contentSafeArea ?? zero,
      ready: record('ready'),
      expand: record('expand'),
      close: record('close'),
      isVersionAtLeast: () => true,
      setHeaderColor: record('setHeaderColor'),
      setBackgroundColor: record('setBackgroundColor'),
      setBottomBarColor: record('setBottomBarColor'),
      openLink: record('openLink'),
      openTelegramLink: record('openTelegramLink'),
      enableClosingConfirmation: record('enableClosingConfirmation'),
      disableClosingConfirmation: record('disableClosingConfirmation'),
      onEvent: (event: string, callback: () => void) => {
        (listeners[event] ??= []).push(callback);
      },
      offEvent: (event: string, callback: () => void) => {
        removeFrom((listeners[event] ??= []), callback);
      },
      BackButton: {
        show: record('BackButton.show'),
        hide: record('BackButton.hide'),
        onClick: (callback: () => void) => void backHandlers.push(callback),
        offClick: (callback: () => void) => removeFrom(backHandlers, callback),
      },
      MainButton: {
        setText: record('MainButton.setText'),
        show: record('MainButton.show'),
        hide: record('MainButton.hide'),
        enable: record('MainButton.enable'),
        disable: record('MainButton.disable'),
        showProgress: record('MainButton.showProgress'),
        hideProgress: record('MainButton.hideProgress'),
        onClick: (callback: () => void) => void mainHandlers.push(callback),
        offClick: (callback: () => void) => removeFrom(mainHandlers, callback),
      },
      HapticFeedback: {
        impactOccurred: record('HapticFeedback.impactOccurred'),
        notificationOccurred: record('HapticFeedback.notificationOccurred'),
        selectionChanged: record('HapticFeedback.selectionChanged'),
      },
    };
    const win = window as unknown as Record<string, unknown>;
    win.Telegram = { WebApp: webApp };
    win.__tgCalls = calls;
    win.__tgEmit = (event: string) => (listeners[event] ?? []).slice().forEach((cb) => cb());
    win.__tgSet = (patch: Record<string, unknown>) => Object.assign(webApp, patch);
    win.__tgPressMain = () => mainHandlers.slice().forEach((cb) => cb());
    win.__tgPressBack = () => backHandlers.slice().forEach((cb) => cb());
  }, options);
}

export const tgCalls = (page: Page): Promise<TgCall[]> =>
  page.evaluate(() => (window as unknown as { __tgCalls: TgCall[] }).__tgCalls.slice());

export const tgCallNames = async (page: Page): Promise<string[]> =>
  (await tgCalls(page)).map(([name]) => name);

export function tgEmit(page: Page, event: string): Promise<void> {
  return page.evaluate((name) => {
    (window as unknown as { __tgEmit: (event: string) => void }).__tgEmit(name);
  }, event);
}

export function tgSet(page: Page, patch: Record<string, unknown>): Promise<void> {
  return page.evaluate((value) => {
    (window as unknown as { __tgSet: (patch: Record<string, unknown>) => void }).__tgSet(value);
  }, patch);
}

export function tgPressBack(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __tgPressBack: () => void }).__tgPressBack();
  });
}

export function tgPressMain(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __tgPressMain: () => void }).__tgPressMain();
  });
}
