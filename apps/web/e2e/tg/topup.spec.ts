import { expect, test, type Page } from '@playwright/test';
import { INTENT_ID, PAY_TOKEN } from '../fixtures/payments';
import { tgPressMain } from '../fixtures/telegram';
import { shot } from '../pay/pay-support';
import { axeViolations, overflow } from './support';
import {
  SCHEMES,
  TEXT,
  mainButtonCalls,
  openLinks,
  openTopup,
  storeTopup,
  tgTopup,
  type Lang,
} from './topup-support';

// The Mini App top-up, amount side (phase 7 S8, TopupMini.dc.html): amount -> the payment page opens
// in the browser (openLink) -> the waiting screen (topup-waiting.spec.ts). The card is never shown
// inside the Mini App.

const LANGS: Lang[] = ['uz', 'ru'];
const main = (page: Page) => page.locator('main');
const field = (page: Page, lang: Lang) =>
  page.getByRole('textbox', { name: storeTopup(lang).amount.label });

test.describe('amount', () => {
  for (const lang of LANGS) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: limits from the server, quick amounts, card type, how it works`, async ({
        page,
      }, testInfo) => {
        const s = storeTopup(lang);
        await openTopup(page, { lang, scheme });
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(s.title);
        await expect(field(page, lang)).toBeVisible();
        await expect(main(page)).toContainText(/5\s000/);
        await expect(main(page)).toContainText(/2\s000\s000/);
        await expect(page.getByRole('radio', { name: s.cardType.auto })).toBeChecked();
        await expect(page.getByRole('radio', { name: s.cardType.humo })).toBeVisible();
        await expect(page.getByRole('radio', { name: s.cardType.uzcard })).toBeVisible();
        await expect(main(page)).toContainText(s.how.one);
        await expect(main(page)).toContainText(s.how.tail);
        await expect(page.locator('body')).not.toContainText('9860');
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `tg-topup-amount-${lang}-${scheme}`);
      });
    }
  }

  test('a quick amount fills the field; the native main button says "Davom etish · 50 000 so‘m"', async ({
    page,
  }) => {
    await openTopup(page);
    await expect(field(page, 'uz')).toBeVisible();
    await expect(page.getByRole('button', { name: storeTopup('uz').continue })).toHaveCount(0);
    await page.getByRole('button', { name: '50 000' }).click();
    await expect(field(page, 'uz')).toHaveValue(/50\s000/);
    await expect
      .poll(async () =>
        (await mainButtonCalls(page)).some(
          ([name, text]) =>
            name === 'MainButton.setText' && /^Davom etish · 50\s000\sso‘m$/.test(String(text)),
        ),
      )
      .toBe(true);
    expect((await mainButtonCalls(page)).map(([name]) => name)).toContain('MainButton.enable');
  });

  test('an amount off the step or out of range says so and stays unsent', async ({ page }) => {
    const s = storeTopup('uz');
    const api = await openTopup(page);
    await field(page, 'uz').fill('5500');
    await expect(main(page)).toContainText(/1\s000\sso‘mga karrali/);
    await tgPressMain(page);
    await field(page, 'uz').fill('1000');
    await expect(main(page)).toContainText(s.errors.min.replace('{min}', '').trim());
    await field(page, 'uz').fill('9000000');
    await expect(main(page)).toContainText(s.errors.max.replace('{max}', '').trim());
    await tgPressMain(page);
    expect(api.creates).toEqual([]);
  });
});

test.describe('creating the request', () => {
  test('sends the amount in tiyin with an Idempotency-Key, opens ONLY our pay page, shows the waiting screen', async ({
    page,
  }) => {
    const api = await openTopup(page);
    await page.getByRole('button', { name: '50 000' }).click();
    await page.getByRole('radio', { name: storeTopup('uz').cardType.humo }).click();
    await tgPressMain(page);

    await expect(page).toHaveURL(new RegExp(`/tg/topup/${INTENT_ID}$`));
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]).toMatchObject({ amountTiyin: '5000000', bank: 'HUMO' });
    expect(api.creates[0]?.key).toMatch(/^[\w-]{16,}$/);

    const links = await openLinks(page);
    expect(links).toHaveLength(1);
    const link = new URL(links[0] ?? '');
    expect(link.origin).toBe('http://localhost:3100');
    expect(link.pathname).toBe(`/pay/${INTENT_ID}`);
    expect(link.hash).toBe(`#t=${PAY_TOKEN}`);
    expect(link.search).toBe('?locale=uz');

    expect(page.url()).not.toContain(PAY_TOKEN);
    const stored = await page.evaluate(() =>
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
    );
    expect(stored).not.toContain(PAY_TOKEN);
    await expect(page.locator('body')).not.toContainText(PAY_TOKEN);
    await expect(page.locator('body')).not.toContainText('9860');
  });

  test('a link on another origin is never opened: nothing leaves, the screen says so', async ({
    page,
  }) => {
    const api = await openTopup(page, { payments: { redirect: 'foreign' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(main(page)).toContainText(TEXT.uz.errors.INTERNAL_ERROR);
    expect(await openLinks(page)).toEqual([]);
    expect(page.url()).toMatch(/\/tg\/topup$/);
    expect(api.creates).toHaveLength(1);
  });

  test('a client that refuses openLink: no "opened in the browser" screen, the link waits for one more press', async ({
    page,
  }) => {
    const w = tgTopup('uz').waiting;
    await openTopup(page, { refusals: 1 });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(page.getByRole('alert').filter({ hasText: w.linkError })).toBeVisible();
    await expect(page.getByRole('heading', { name: w.title })).toHaveCount(0);
    expect(page.url()).toMatch(/\/tg\/topup$/);
    expect(await openLinks(page)).toHaveLength(1); // the refused call
    await expect
      .poll(async () =>
        (await mainButtonCalls(page)).some(
          ([n, text]) => n === 'MainButton.setText' && text === w.openPage,
        ),
      )
      .toBe(true);

    await tgPressMain(page); // the press that opens it
    await expect(page).toHaveURL(new RegExp(`/tg/topup/${INTENT_ID}$`));
    expect(await openLinks(page)).toHaveLength(2);
    expect(page.url()).not.toContain(PAY_TOKEN);
  });

  test('a lost answer is retried by the visitor with the SAME key, never by the page', async ({
    page,
  }) => {
    const api = await openTopup(page, { payments: { create: 'networkOnce' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(main(page)).toContainText(TEXT.uz.common.error.network);
    expect(api.creates).toHaveLength(1);
    await page.waitForTimeout(1500);
    expect(api.creates).toHaveLength(1);
    await tgPressMain(page);
    await expect(page).toHaveURL(new RegExp(`/tg/topup/${INTENT_ID}$`));
    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]?.key).toBe(api.creates[0]?.key);
  });

  test('the server refuses the amount: its numbers are shown, nothing opens', async ({ page }) => {
    const api = await openTopup(page, { payments: { create: 'range' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(main(page)).toContainText(/5\s000/);
    await expect(main(page)).toContainText(/karrali/);
    expect(await openLinks(page)).toEqual([]);
    expect(api.creates).toHaveLength(1);
    expect(page.url()).toMatch(/\/tg\/topup$/);
  });

  test('the daily limit is used up: said plainly', async ({ page }) => {
    await openTopup(page, { payments: { create: 'dailyDone' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(main(page)).toContainText(storeTopup('uz').errors.newAccountDone);
  });

  test('429: the seconds to wait are said and the button stays off for that long', async ({
    page,
  }) => {
    const api = await openTopup(page, { payments: { create: 'rateLimited' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(main(page)).toContainText(/\d+ soniyadan keyin/);
    const calls = (await mainButtonCalls(page)).map(([name]) => name);
    expect(calls.filter((n) => n === 'MainButton.enable' || n === 'MainButton.disable').pop()).toBe(
      'MainButton.disable',
    );
    await tgPressMain(page);
    expect(api.creates).toHaveLength(1);
  });

  test('a blocked account (403 USER_BLOCKED) gets its own text', async ({ page }) => {
    await openTopup(page, { payments: { create: 'blocked' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(main(page)).toContainText(TEXT.uz.errors.USER_BLOCKED);
  });

  test('409 IDEMPOTENCY_CONFLICT with no waiting request to show: said under the field', async ({
    page,
  }) => {
    await openTopup(page, { payments: { create: 'conflict' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(main(page)).toContainText(storeTopup('uz').errors.conflict);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('no card is available (503): "temporarily unavailable" with a retry', async ({ page }) => {
    const s = storeTopup('uz');
    await openTopup(page, { payments: { create: 'unavailable' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(page.getByText(s.unavailable.title)).toBeVisible();
    await expect(page.getByRole('button', { name: s.unavailable.retry })).toBeVisible();
  });

  test('the methods are unavailable up front: the same screen, no form', async ({ page }) => {
    await openTopup(page, { payments: { methods: 'unavailable' } });
    await expect(page.getByText(storeTopup('uz').unavailable.title)).toBeVisible();
    await expect(field(page, 'uz')).toHaveCount(0);
  });

  test('the methods fail to load: an error with a retry', async ({ page }) => {
    await openTopup(page, { payments: { methods: 'error' } });
    await expect(page.getByRole('button', { name: TEXT.uz.common.retry })).toBeVisible();
    await expect(field(page, 'uz')).toHaveCount(0);
  });
});
