import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import { installFakeWebApp, stubTelegramSdk, tgCallNames } from '../fixtures/telegram';
import { installTgApi, TG_TOKEN, type LoginAnswer } from '../fixtures/tg-api';
import { E2E_BOT_URL } from '../support/app-env';
import { axeViolations, INIT_DATA, open, overflow } from './support';

// The Mini App gates (phase 7 S4): every reason a visitor is not let in, and what is kept out of
// sight on the way in. API faked with `page.route`.

type Lang = 'uz' | 'ru';
const CATALOGS = { uz, ru } as const;

test.describe('gates', () => {
  test('gate-bot: opened in a plain browser, with the link to the bot', async ({ page }) => {
    await stubTelegramSdk(page);
    const api = await installTgApi(page);
    await page.goto('/tg');
    await expect(page.getByRole('heading', { name: uz.tg.gate.bot.title })).toBeVisible();
    await expect(page.getByText(uz.tg.gate.bot.body)).toBeVisible();
    const link = page.getByRole('link', { name: uz.tg.gate.bot.cta });
    await expect(link).toHaveAttribute('href', E2E_BOT_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    // Nothing was sent anywhere: there is no initData to send.
    expect(api.loginCalls()).toBe(0);
    expect(page.url()).toMatch(/\/tg$/);
  });

  test('gate-bot is also what the SDK object of a plain browser (empty initData) gets', async ({
    page,
  }) => {
    await installFakeWebApp(page, { initData: '' });
    const api = await installTgApi(page);
    await page.goto('/tg');
    await expect(page.getByRole('heading', { name: uz.tg.gate.bot.title })).toBeVisible();
    expect(api.loginCalls()).toBe(0);
    expect(await tgCallNames(page)).not.toContain('ready');
  });

  test('gate-blocked: 403 USER_BLOCKED, no retry, stays in /tg', async ({ page }) => {
    await open(page, { answers: [{ kind: 'error', status: 403, code: 'USER_BLOCKED' }] });
    await expect(page.getByRole('heading', { name: uz.tg.gate.blocked.title })).toBeVisible();
    await expect(page.getByText(uz.tg.gate.blocked.body)).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(0);
    expect(page.url()).toMatch(/\/tg$/);
  });

  test('gate-offline: no connection; retry signs in again and opens the app', async ({ page }) => {
    const api = await open(page, { answers: [{ kind: 'drop' }, { kind: 'ok' }] });
    await expect(page.getByRole('heading', { name: uz.tg.gate.offline.title })).toBeVisible();
    await expect(page.getByText(uz.tg.gate.offline.body)).toBeVisible();
    await page.getByRole('button', { name: uz.common.retry }).click();
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();
    expect(api.loginCalls()).toBe(2);
  });

  test('gate-offline: the connection coming back retries by itself', async ({ page }) => {
    await open(page, { answers: [{ kind: 'drop' }, { kind: 'ok' }] });
    await expect(page.getByRole('heading', { name: uz.tg.gate.offline.title })).toBeVisible();
    // The listener is added a moment after the gate is painted: signal until the app opens (the
    // fake API answers "ok" from the second login on, so an extra signal is harmless).
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible({ timeout: 500 });
    }).toPass();
  });

  test('gate-offline: keyboard only', async ({ page }) => {
    await open(page, { answers: [{ kind: 'drop' }, { kind: 'ok' }] });
    await expect(page.getByRole('heading', { name: uz.tg.gate.offline.title })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: uz.common.retry })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();
  });

  for (const code of ['INITDATA_EXPIRED', 'INITDATA_INVALID']) {
    test(`${code}: asks to reopen the app, and closes it`, async ({ page }) => {
      const api = await open(page, { answers: [{ kind: 'error', status: 401, code }] });
      await expect(page.getByRole('heading', { name: uz.tg.gate.reopen.title })).toBeVisible();
      // Telegram's launch data is final: the app does not keep posting it.
      expect(api.loginCalls()).toBe(1);
      await page.getByRole('button', { name: uz.tg.gate.reopen.cta }).click();
      expect(await tgCallNames(page)).toContain('close');
      expect(page.url()).toMatch(/\/tg$/);
    });
  }

  test('any other failure shows the server message and a retry', async ({ page }) => {
    await open(page, { answers: [{ kind: 'error', status: 429, code: 'RATE_LIMITED' }] });
    await expect(page.getByRole('heading', { name: uz.tg.gate.error.title })).toBeVisible();
    await expect(page.getByText(uz.errors.RATE_LIMITED)).toBeVisible();
    await expect(page.getByRole('button', { name: uz.common.retry })).toBeVisible();
  });

  // Every gate that comes from a sign-in attempt, both themes, both languages (Telegram's
  // language_code decides). The bot gate has its own block below: it has no Telegram.
  const GATES: { name: string; answers: LoginAnswer[]; title: (lang: Lang) => string }[] = [
    {
      name: 'blocked',
      answers: [{ kind: 'error', status: 403, code: 'USER_BLOCKED' }],
      title: (lang) => CATALOGS[lang].tg.gate.blocked.title,
    },
    {
      name: 'offline',
      answers: [{ kind: 'drop' }],
      title: (lang) => CATALOGS[lang].tg.gate.offline.title,
    },
    {
      name: 'reopen',
      answers: [{ kind: 'error', status: 401, code: 'INITDATA_EXPIRED' }],
      title: (lang) => CATALOGS[lang].tg.gate.reopen.title,
    },
  ];

  for (const gate of GATES) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const lang of ['uz', 'ru'] as const) {
        test(`${gate.name} / ${scheme} / ${lang}: fits the screen and passes the accessibility scan`, async ({
          page,
        }) => {
          await open(page, { colorScheme: scheme, languageCode: lang, answers: gate.answers });
          await expect(page.getByRole('heading', { name: gate.title(lang) })).toBeVisible();
          expect(await overflow(page)).toBeLessThanOrEqual(0);
          // The action button, when there is one, is fully inside the screen.
          const action = page.locator('main button, main a').first();
          if ((await action.count()) > 0) {
            const box = await action.boundingBox();
            const viewport = page.viewportSize();
            expect(box).not.toBeNull();
            if (box && viewport) {
              expect(box.x).toBeGreaterThanOrEqual(0);
              expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
              expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
            }
          }
          expect(await axeViolations(page)).toEqual([]);
        });
      }
    }
  }
});

// The bot gate is what a plain browser gets: no Telegram, so the colours follow the OS setting and
// the language follows the browser language (only the text; nothing about access).
for (const [lang, locale] of [
  ['uz', 'uz-UZ'],
  ['ru', 'ru-RU'],
] as const) {
  test.describe(`bot gate, browser language ${locale}`, () => {
    test.use({ locale });

    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme}: really ${scheme}, in ${lang}, fits the screen, accessible`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await stubTelegramSdk(page);
        const api = await installTgApi(page);
        await page.goto('/tg');
        const copy = CATALOGS[lang].tg.gate.bot;
        await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
        await expect(page.getByText(copy.body)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        const background = await page
          .locator('main')
          .evaluate((node) => getComputedStyle(node).backgroundColor);
        expect(background).toBe(scheme === 'dark' ? 'rgb(8, 12, 24)' : 'rgb(242, 244, 249)');
        expect(api.loginCalls()).toBe(0);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    }

    test('a screenshot of the dark gate differs from the light one', async ({ page }) => {
      await stubTelegramSdk(page);
      await installTgApi(page);
      const shots: Buffer[] = [];
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/tg');
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        shots.push(await page.screenshot());
      }
      expect(shots[0]?.equals(shots[1] ?? Buffer.alloc(0))).toBe(false);
    });
  });
}

test.describe('the launch data and the token stay out of sight', () => {
  test('initData travels once, in the body of the login request, and is stored nowhere', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (message) => problems.push(message.text()));
    const requestUrls: string[] = [];
    page.on('request', (request) => requestUrls.push(request.url()));

    const api = await open(page);
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();

    const logins = api.requests.filter((r) => r.url().endsWith('/auth/telegram/webapp'));
    expect(logins).toHaveLength(1);
    const login = logins[0];
    expect(login?.method()).toBe('POST');
    expect(JSON.parse(login?.postData() ?? '{}')).toEqual({ initData: INIT_DATA });
    expect(login?.headers().authorization).toBeUndefined();

    // Not in any URL, referrer, console line, storage or cookie.
    expect(requestUrls.filter((url) => url.includes(INIT_DATA) || url.includes('hash='))).toEqual(
      [],
    );
    expect(problems.filter((line) => line.includes(INIT_DATA))).toEqual([]);
    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: { ...window.localStorage },
        session: { ...window.sessionStorage },
        cookie: document.cookie,
      }),
    );
    expect(stored).not.toContain(INIT_DATA);
    expect(stored).not.toContain('auth_date');
    expect(stored).not.toContain(TG_TOKEN);
    expect(await page.context().cookies()).toEqual([]);
  });
});
