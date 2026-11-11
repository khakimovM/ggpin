import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import {
  installFakeWebApp,
  tgCallNames,
  tgCalls,
  tgEmit,
  tgPressBack,
  tgSet,
} from '../fixtures/telegram';
import { installTgApi } from '../fixtures/tg-api';
import { unexpectedProblems } from '../support/fake-api';
import { watchPage } from '../support/gallery';
import { axeViolations, INIT_DATA, open, overflow } from './support';

// The Mini App shell (phase 7 S4): the link to Telegram (ready/expand, theme, safe area), the
// and the splash. The home screen is in home.spec.ts. API faked with `page.route`; the Telegram SDK is a fake
// installed before the page scripts (fixtures/telegram.ts). The gates are in gates.spec.ts.

const BACKGROUND = { light: 'rgb(242, 244, 249)', dark: 'rgb(8, 12, 24)' } as const;
// The browser reports custom properties in lower case; Telegram accepts either.
const HEX = { light: '#f2f4f9', dark: '#080c18' } as const;

test.describe('Telegram connection', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme}: ready and expand are called, the theme follows colorScheme`, async ({
      page,
    }) => {
      const problems = watchPage(page);
      await open(page, { colorScheme: scheme });
      await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();

      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        'rgba(0, 0, 0, 0)',
      );
      const mainBackground = await page
        .locator('main')
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(mainBackground).toBe(BACKGROUND[scheme]);

      const names = await tgCallNames(page);
      expect(names.filter((name) => name === 'ready')).toHaveLength(1);
      expect(names.filter((name) => name === 'expand')).toHaveLength(1);
      expect(unexpectedProblems(problems)).toEqual([]);
    });

    test(`${scheme}: Telegram's header and background take our --background`, async ({ page }) => {
      await open(page, { colorScheme: scheme });
      await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();
      const calls = await tgCalls(page);
      expect(calls).toContainEqual(['setHeaderColor', HEX[scheme]]);
      expect(calls).toContainEqual(['setBackgroundColor', HEX[scheme]]);
      expect(calls).toContainEqual(['setBottomBarColor', HEX[scheme]]);
    });
  }

  test('the SDK script that Next loads before hydration is read in time', async ({ page }) => {
    // No fake installed up front: the (stubbed) SDK file itself defines window.Telegram, the way
    // the real one does, so this proves the script is in place before the provider looks.
    const sdk = `window.Telegram={WebApp:{initData:${JSON.stringify(INIT_DATA)},initDataUnsafe:{user:{language_code:'uz'}},colorScheme:'dark',ready:function(){window.__sdkReady=true},expand:function(){},onEvent:function(){},offEvent:function(){}}}`;
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: sdk }),
    );
    const api = await installTgApi(page);
    await page.goto('/tg');
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();
    expect(api.loginCalls()).toBe(1);
    expect(
      await page.evaluate(() => (window as unknown as { __sdkReady?: boolean }).__sdkReady),
    ).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('themeChanged switches the page and repaints Telegram', async ({ page }) => {
    await open(page, { colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await tgSet(page, { colorScheme: 'dark' });
    await tgEmit(page, 'themeChanged');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(async () =>
        (await tgCalls(page)).some(([n, c]) => n === 'setHeaderColor' && c === HEX.dark),
      )
      .toBe(true);
  });

  test('the safe-area insets become CSS variables and follow safeAreaChanged', async ({ page }) => {
    await open(page, {
      safeArea: { top: 47, bottom: 34, left: 0, right: 0 },
      contentSafeArea: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();
    const read = (name: string) =>
      page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name);
    expect(await read('--tg-safe-top')).toBe('47px');
    expect(await read('--tg-safe-bottom')).toBe('34px');
    // The page content really keeps clear of the top inset.
    const top = await page.locator('main').evaluate((node) => getComputedStyle(node).paddingTop);
    expect(top).toBe('47px');

    await tgSet(page, { contentSafeAreaInset: { top: 56, bottom: 0, left: 0, right: 0 } });
    await tgEmit(page, 'contentSafeAreaChanged');
    await expect.poll(() => read('--tg-safe-top')).toBe('103px');
  });

  test('the first language guess comes from Telegram; the profile locale then wins', async ({
    page,
  }) => {
    await open(page, {
      languageCode: 'ru',
      answers: [{ kind: 'ok', user: { locale: 'uz' } }],
    });
    // Signed in as a uz profile although Telegram said ru.
    await expect(
      page.getByRole('button', { name: uz.store.catalog.categories.all, exact: true }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'uz');
  });
});

test.describe('splash', () => {
  test('is shown while Telegram signs the visitor in, in both languages', async ({ page }) => {
    for (const [code, text] of [
      ['uz', uz.tg.splash.signingIn],
      ['ru', ru.tg.splash.signingIn],
    ] as const) {
      const fresh = await page.context().newPage();
      await installFakeWebApp(fresh, { initData: INIT_DATA, languageCode: code });
      const api = await installTgApi(fresh);
      api.hold();
      await fresh.goto('/tg');
      await expect(fresh.getByText(text)).toBeVisible();
      await expect(fresh.getByRole('progressbar')).toBeVisible();
      expect(await overflow(fresh)).toBeLessThanOrEqual(0);
      api.release();
      await expect(fresh.getByRole('heading', { name: /Sardor|Сардор/ })).toBeVisible();
      await fresh.close();
    }
  });

  test('reduced motion: every animation is cut to one 1 ms pass', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installFakeWebApp(page, { initData: INIT_DATA });
    const api = await installTgApi(page);
    api.hold();
    await page.goto('/tg');
    await expect(page.getByRole('progressbar')).toBeVisible();
    const animations = await page.locator('main [class*="animate-"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return [style.animationName, style.animationDuration, style.animationIterationCount];
      }),
    );
    expect(animations.length).toBeGreaterThan(0);
    for (const [name, duration, count] of animations) {
      expect(name === 'none' || (duration === '0.001s' && count === '1')).toBe(true);
    }
    api.release();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme}: passes the accessibility scan`, async ({ page }) => {
      await installFakeWebApp(page, { initData: INIT_DATA, colorScheme: scheme });
      const api = await installTgApi(page);
      api.hold();
      await page.goto('/tg');
      await expect(page.getByRole('progressbar')).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      api.release();
    });
  }
});

test.describe('native BackButton', () => {
  test('is on for a screen below the home page and off on the home page', async ({ page }) => {
    await installFakeWebApp(page, { initData: INIT_DATA });
    await installTgApi(page);
    await page.goto('/tg/a.b');
    await expect(page.getByRole('heading', { name: uz.common.notFound.title })).toBeVisible();
    await expect.poll(() => tgCallNames(page)).toContain('BackButton.show');
    await page.getByRole('link', { name: uz.common.notFound.cta }).click();
    await expect(page).toHaveURL(/\/tg$/);
    await expect.poll(() => tgCallNames(page)).toContain('BackButton.hide');
  });

  // The case a `history.length` check gets wrong: a deep link /tg/a.b, a push to /tg, and the
  // browser's back to /tg/a.b. The history has 3 entries, but the app has nothing of its own
  // left to go back to, so the button must take the visitor home instead of doing nothing (or
  // leaving the Mini App for the page before it).
  test('deep link, push, back: the button goes to the home page, it is not dead', async ({
    page,
  }) => {
    await installFakeWebApp(page, { initData: INIT_DATA });
    await installTgApi(page);
    await page.goto('/tg/a.b');
    await expect(page.getByRole('heading', { name: uz.common.notFound.title })).toBeVisible();
    await page.getByRole('link', { name: uz.common.notFound.cta }).click();
    await expect(page).toHaveURL(/\/tg$/);
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/tg\/a\.b$/);
    await expect(page.getByRole('heading', { name: uz.common.notFound.title })).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBeGreaterThan(1);
    // The button is shown again for this screen (show, hide on the home page, show again).
    await expect
      .poll(async () => (await tgCallNames(page)).filter((n) => n === 'BackButton.show').length)
      .toBe(2);

    await tgPressBack(page);
    await expect(page).toHaveURL(/\/tg$/);
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();
  });
});
