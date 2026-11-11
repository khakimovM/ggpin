import AxeBuilder from '@axe-core/playwright';
import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test, type Page } from '@playwright/test';
import { watchPage } from '../support/gallery';
import {
  BAD_CODE,
  BOT_URL,
  GOOD_CODE,
  installFakeApi,
  unexpectedProblems,
  type FakeApiOptions,
} from '../support/fake-api';

// Journey 1: web sign-in through the bot (phase 7 S3). The API is faked with `page.route`; the
// bot, the OTP and the cookies are not real. Each run covers one language and one theme; the
// per-viewport projects (375 / 390 / 768 / 1440) repeat it.

const CATALOGS = {
  uz: { text: uz.web, path: '/login', store: '/store' },
  ru: { text: ru.web, path: '/ru/login', store: '/ru/store' },
} as const;
type Lang = keyof typeof CATALOGS;

async function openLogin(page: Page, lang: Lang, theme: 'light' | 'dark', query = '') {
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), theme);
  await page.goto(`${CATALOGS[lang].path}${query}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
}

const box = (page: Page, lang: Lang, position: number) =>
  page.getByRole('textbox', {
    name: CATALOGS[lang].text.login.codeBox.replace('{position}', String(position)),
  });

/** Types a code the way a person does: digit by digit, into the focused box. */
async function typeCode(page: Page, lang: Lang, code: string) {
  await expect(box(page, lang, 1)).toBeVisible({ timeout: 15_000 });
  await box(page, lang, 1).click();
  await page.keyboard.type(code);
}

async function clearCode(page: Page) {
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Backspace');
}

// `welcome` is the web store's heading for the "all" category (Store.dc.html: "Barcha mahsulotlar").
const journeyCases = [
  {
    lang: 'uz',
    theme: 'light',
    wrong: 'Kod noto‘g‘ri. Yana 4 ta urinish qoldi',
    welcome: 'Barcha mahsulotlar',
  },
  {
    lang: 'ru',
    theme: 'dark',
    wrong: 'Код неверный. Осталось 4 попытки',
    welcome: 'Все товары',
  },
] as const;

test.describe('journey 1: sign in through Telegram', () => {
  for (const { lang, theme, wrong, welcome } of journeyCases) {
    test(`${lang}, ${theme}: start, bot link, wrong code, right code, store`, async ({ page }) => {
      const problems = watchPage(page);
      const urls: string[] = [];
      page.on('request', (request) => urls.push(request.url()));
      const api = await installFakeApi(page);
      const t = CATALOGS[lang].text;
      await openLogin(page, lang, theme);

      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        t.login.title.replace('{brand}', 'ggpin'),
      );
      await page.getByRole('button', { name: t.login.start }).click();

      // The bot link comes from the API answer, and opens outside this tab.
      const link = page.getByRole('link', { name: t.login.openTelegram });
      await expect(link).toHaveAttribute('href', BOT_URL);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(page.getByRole('status')).toHaveText(t.login.waiting);

      // The status poll sees CODE_SENT (the second answer, ~2 s later) and the boxes appear.
      await expect(box(page, lang, 1)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(t.login.codeSent)).toBeVisible();

      await typeCode(page, lang, BAD_CODE);
      await expect(page.getByText(wrong)).toBeVisible();
      await expect(box(page, lang, 1)).toHaveAttribute('aria-invalid', 'true');

      await clearCode(page);
      await expect(page.getByText(wrong)).toBeHidden();
      await typeCode(page, lang, GOOD_CODE);

      await expect(page).toHaveURL(new RegExp(`${CATALOGS[lang].store}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(welcome);

      expect(api.count('POST /auth/telegram/start')).toBe(1);
      expect(api.count('POST /auth/telegram/verify')).toBe(2);
      expect(api.count('GET /me')).toBeGreaterThanOrEqual(1);
      // A one-time code goes in a request body, never into a URL.
      expect(urls.filter((url) => url.includes(GOOD_CODE) || url.includes(BAD_CODE))).toEqual([]);
      expect(unexpectedProblems(problems)).toEqual([]);
    });
  }

  test('"Yangi kod olish" in the code step starts the login again with a new nonce', async ({
    page,
  }) => {
    const api = await installFakeApi(page, { statuses: ['CODE_SENT', 'PENDING'] });
    await openLogin(page, 'uz', 'light');
    await page.getByRole('button', { name: uz.web.login.start }).click();
    await expect(box(page, 'uz', 1)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: uz.web.login.newCode }).click();

    await expect(page.getByRole('link', { name: uz.web.login.openTelegram })).toBeVisible();
    expect(api.count('POST /auth/telegram/start')).toBe(2);
    expect(api.count('POST /auth/telegram/verify')).toBe(0);
  });

  test('a visitor sent to the login page returns to where they were going', async ({ page }) => {
    const api = await installFakeApi(page, { statuses: ['CODE_SENT'] });
    await page.goto('/store/profile');
    // /me answers 401, the refresh is refused: a required request sends the visitor to sign in.
    await expect(page).toHaveURL(/\/login\?next=%2Fstore%2Fprofile$/);
    // (The cleanup after the loss resets the mounted `/me` query, which asks once more.)
    expect(api.count('POST /auth/refresh')).toBeGreaterThanOrEqual(1);

    // A click before hydration does nothing: wait until the theme provider has run.
    await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: uz.web.login.start }).click();
    await typeCode(page, 'uz', GOOD_CODE);

    await expect(page).toHaveURL(/\/store\/profile$/);
    await expect(
      page.getByRole('heading', { level: 1, name: uz.account.profile.title }),
    ).toBeVisible();
  });

  for (const next of ['//evil.com', 'https://evil.com', '/%2F%2Fevil.com', '/\\evil.com']) {
    test(`next=${next} cannot take the visitor off this site`, async ({ page }) => {
      await installFakeApi(page, { statuses: ['CODE_SENT'] });
      // Reaching the attacker's host at all is the failure; make it impossible to succeed silently.
      await page.route(
        (url) => url.hostname === 'evil.com',
        (route) => route.abort(),
      );
      await openLogin(page, 'uz', 'light', `?next=${encodeURIComponent(next)}`);
      await page.getByRole('button', { name: uz.web.login.start }).click();
      await typeCode(page, 'uz', GOOD_CODE);

      await expect(page).toHaveURL(/\/store$/);
      expect(new URL(page.url()).origin).toBe('http://localhost:3100');
    });
  }

  test('keyboard only: Tab reaches the start button and Enter starts the login', async ({
    page,
  }) => {
    await installFakeApi(page, { statuses: ['PENDING'] });
    await openLogin(page, 'uz', 'light');
    const start = page.getByRole('button', { name: uz.web.login.start });
    for (
      let i = 0;
      i < 6 && !(await start.evaluate((node) => node === document.activeElement));
      i += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: uz.web.login.openTelegram })).toBeVisible();
  });
});

interface StateCase {
  name: string;
  api: FakeApiOptions;
  steps: (page: Page, lang: Lang) => Promise<void>;
  expectText: (lang: Lang) => string;
}

const start = (page: Page, lang: Lang) =>
  page.getByRole('button', { name: CATALOGS[lang].text.login.start }).click();

const STATES: StateCase[] = [
  {
    name: 'start',
    api: {},
    steps: () => Promise.resolve(),
    expectText: (l) => CATALOGS[l].text.login.start,
  },
  {
    name: 'waiting',
    api: { statuses: ['PENDING'] },
    steps: start,
    expectText: (l) => CATALOGS[l].text.login.waiting,
  },
  {
    name: 'code',
    api: { statuses: ['CODE_SENT'] },
    steps: start,
    expectText: (l) => CATALOGS[l].text.login.codeSent,
  },
  {
    name: 'wrong',
    api: { statuses: ['CODE_SENT'] },
    steps: async (page, lang) => {
      await start(page, lang);
      await typeCode(page, lang, BAD_CODE);
    },
    expectText: (l) => (l === 'uz' ? 'Yana 4 ta urinish' : 'Осталось 4 попытки'),
  },
  {
    name: 'expired',
    api: { statuses: ['EXPIRED'] },
    steps: start,
    expectText: (l) => CATALOGS[l].text.login.newCode,
  },
  {
    name: 'rejected',
    api: { statuses: ['DENIED'] },
    steps: start,
    expectText: (l) => CATALOGS[l].text.login.rejected.title,
  },
  {
    name: 'error',
    api: { startFails: { status: 500, code: 'INTERNAL_ERROR' } },
    steps: start,
    expectText: (l) => CATALOGS[l].text.login.error.title,
  },
  {
    name: 'rate limited',
    api: { startFails: { status: 429, code: 'RATE_LIMITED', retryAfter: 120 } },
    steps: start,
    expectText: (l) => CATALOGS[l].text.login.error.rateLimited.split('{time}')[0]?.trim() ?? '',
  },
];

test.describe('every state fits the viewport and passes the accessibility scan', () => {
  for (const { lang, theme } of [
    { lang: 'uz', theme: 'light' },
    { lang: 'ru', theme: 'dark' },
  ] as const) {
    for (const state of STATES) {
      test(`${lang}/${theme}: ${state.name}`, async ({ page }) => {
        const problems = watchPage(page);
        await installFakeApi(page, state.api);
        await openLogin(page, lang, theme);
        await state.steps(page, lang);
        await expect(page.getByText(state.expectText(lang)).first()).toBeVisible({
          timeout: 15_000,
        });

        // Russian runs 15-35% longer than Uzbek: nothing may push the page sideways.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);

        const scan = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(scan.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
        expect(unexpectedProblems(problems)).toEqual([]);
      });
    }
  }
});
