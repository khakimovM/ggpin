import { expect, test, type Page } from '@playwright/test';
import { tokenN } from '../fixtures/product';
import { tgCallNames, tgPressBack } from '../fixtures/telegram';
import {
  TEN_MINUTES_MS,
  TEXT,
  attachShot,
  confirmRecipient,
  mainButton,
  openProduct,
  usernameField,
  type Lang,
} from './product-support';
import { axeViolations, overflow } from './support';

// The states of the Mini App product page that are not the happy path (phase 7 S6): the page
// (skeleton, error, unavailable), the recipient (every state of Product.dc.html `recipient`) and the
// price (loading, unavailable, rate limited, expired). The ready page is in product-stars.spec.ts.

const STARS = 'telegram-stars';
const t = (lang: Lang) => TEXT[lang].store.product;

async function lookUp(page: Page, lang: Lang, username: string) {
  await usernameField(page).fill(username);
  await page.getByRole('button', { name: t(lang).recipient.check, exact: true }).click();
}

test.describe('the page', () => {
  test('skeleton while loading, then the page', async ({ page }, testInfo) => {
    const api = await openProduct(page, STARS, { product: { product: 'slow' }, hold: true });
    await expect(page.getByRole('status')).toHaveText(t('uz').loading);
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await attachShot(page, testInfo, 'product-skeleton');
    api.release();
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
  });

  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: an error says so and "retry" loads the page`, async ({ page }, testInfo) => {
      const api = await openProduct(page, STARS, { lang, product: { product: 'error' } });
      await expect(page.getByText(t(lang).error.title)).toBeVisible();
      await expect(page.getByText(t(lang).error.body)).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `product-error-${lang}`);

      // The next answer is a good one.
      api.setProduct('ok');
      await page.getByRole('button', { name: TEXT[lang].common.retry }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
    });
  }

  test('unavailable: a 404 offers the way back to the catalog, and no MainButton', async ({
    page,
  }, testInfo) => {
    await openProduct(page, 'no-such-product', { product: { product: 'missing' } });
    await expect(page.getByText(t('uz').unavailable.title)).toBeVisible();
    await expect(page.getByText(t('uz').unavailable.body)).toBeVisible();
    await expect(page.getByRole('link', { name: t('uz').unavailable.cta })).toHaveAttribute(
      'href',
      '/tg',
    );
    expect((await mainButton(page)).visible).toBeNull();
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'product-unavailable');
  });

  test('unavailable: sold out keeps the header, a product this page cannot sell is not sold', async ({
    page,
  }) => {
    await openProduct(page, STARS, { product: { product: 'soldOut' } });
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
    await expect(page.getByText(t('uz').unavailable.title)).toBeVisible();
    await expect(usernameField(page)).toHaveCount(0);

    const other = await page.context().newPage();
    await openProduct(other, STARS, { product: { product: 'unsupported' } });
    await expect(other.getByText(t('uz').unavailable.title)).toBeVisible();
    await expect(usernameField(other)).toHaveCount(0);
  });
});

test.describe('the recipient', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: each state has its own message, no price is asked, no overflow`, async ({
      page,
    }, testInfo) => {
      const text = t(lang).recipient;
      const api = await openProduct(page, STARS, {
        lang,
        product: {
          recipients: {
            ghost_user: 'notFound',
            bad_user: 'invalid',
            down_user: 'down',
            prem_user: 'hasPremium',
          },
        },
      });

      // Format check on the page: no request.
      await lookUp(page, lang, 'dk');
      await expect(page.getByText(text.invalid)).toBeVisible();
      expect(api.recipientBodies).toHaveLength(0);

      await lookUp(page, lang, 'ghost_user');
      await expect(page.getByText(text.notFound)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await attachShot(page, testInfo, `recipient-notfound-${lang}`);

      await lookUp(page, lang, 'bad_user');
      await expect(page.getByText(text.invalid)).toBeVisible();

      await lookUp(page, lang, 'down_user');
      await expect(page.getByText(text.down)).toBeVisible();
      await page.getByRole('button', { name: TEXT[lang].common.retry }).click();
      await expect.poll(() => api.recipientBodies.length).toBe(4);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await attachShot(page, testInfo, `recipient-down-${lang}`);

      await lookUp(page, lang, 'prem_user');
      await expect(page.getByRole('alert').filter({ hasText: text.blocked.title })).toBeVisible();
      await expect(page.getByText(text.blocked.body)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `recipient-blocked-${lang}`);

      // None of them gave a token: no quote, MainButton off.
      expect(api.quoteBodies).toHaveLength(0);
      expect((await mainButton(page)).enabled).toBe(false);
    });
  }

  test('checking: a skeleton in the card while the server looks', async ({ page }, testInfo) => {
    const api = await openProduct(page, STARS, {
      product: { recipients: { slow_user: 'slow' } },
      hold: true,
    });
    await lookUp(page, 'uz', 'slow_user');
    await expect(page.locator('div[aria-busy="true"]')).toBeVisible();
    await expect(usernameField(page)).toBeDisabled();
    await attachShot(page, testInfo, 'recipient-checking');
    api.release();
    await expect(page.getByText(t('uz').recipient.prompt)).toBeVisible();
  });

  test('found: the person must be confirmed; "O‘zgartirish" goes back to the field', async ({
    page,
  }, testInfo) => {
    await openProduct(page, STARS);
    await lookUp(page, 'uz', 'dilnoza_k');
    await expect(page.getByText('Dilnoza K.')).toBeVisible();
    await expect(page.getByText('@dilnoza_k')).toBeVisible();
    await attachShot(page, testInfo, 'recipient-found');
    await page.getByRole('button', { name: t('uz').recipient.change, exact: true }).click();
    await expect(usernameField(page)).toHaveValue('dilnoza_k');
    await confirmRecipient(page, 'uz', 'dilnoza_k');
    await expect(page.getByRole('img', { name: t('uz').recipient.confirmed })).toBeVisible();
    await attachShot(page, testInfo, 'recipient-confirmed');
  });
});

test.describe('the price', () => {
  test('503 PRICE_UNAVAILABLE: no price, "Qayta urinish" gets one when it is back', async ({
    page,
  }, testInfo) => {
    const api = await openProduct(page, STARS, { product: { quote: 'priceUnavailable' } });
    await confirmRecipient(page);
    await expect(page.getByText(t('uz').quote.unavailable)).toBeVisible();
    expect((await mainButton(page)).enabled).toBe(false);
    await attachShot(page, testInfo, 'quote-unavailable');

    api.setQuote('ok');
    await page.getByRole('alert').getByRole('button', { name: TEXT.uz.common.retry }).click();
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
    expect(api.quoteBodies).toHaveLength(2);
  });

  test('429: tells the visitor and asks again by itself after Retry-After', async ({ page }) => {
    const api = await openProduct(page, STARS, { product: { quote: 'rateLimited' } });
    await confirmRecipient(page);
    await expect(page.getByText(/4 soniyadan keyin/)).toBeVisible();
    expect(api.quoteBodies).toHaveLength(1);
    api.setQuote('ok');
    await expect.poll(() => api.quoteBodies.length, { timeout: 8000 }).toBe(2);
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
  });

  test('an expired quote switches the button off and is NOT renewed by itself', async ({
    page,
  }, testInfo) => {
    const api = await openProduct(page, STARS, { clock: true });
    await confirmRecipient(page);
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
    // The quote lives ten minutes from the moment it was asked for, on THIS page's clock.
    await page.clock.fastForward(TEN_MINUTES_MS + 30_000);
    await expect(
      page
        .getByRole('region', { name: t('uz').summary.label })
        .getByText(t('uz').quote.expired, { exact: true }),
    ).toBeVisible();
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: false });
    await page.waitForTimeout(1500);
    expect(api.quoteBodies).toHaveLength(1);
    await attachShot(page, testInfo, 'quote-expired');

    await page.getByRole('button', { name: t('uz').quote.refresh }).click();
    await expect.poll(() => api.quoteBodies.length).toBe(2);
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
  });

  test('a refreshed price after the recipient token died: back to confirm again, then a new token works', async ({
    page,
  }, testInfo) => {
    const api = await openProduct(page, STARS, { clock: true });
    await confirmRecipient(page);
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
    // The token lives ten minutes too, and is older than the quote: when the quote is stale the
    // server has forgotten the token.
    // The quote lives ten minutes from the moment it was asked for, on THIS page's clock.
    await page.clock.fastForward(TEN_MINUTES_MS + 30_000);
    api.killTokens();
    await expect(
      page.getByRole('region', { name: t('uz').summary.label }).getByText(t('uz').quote.expired, {
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole('button', { name: t('uz').quote.refresh }).click();
    // The server: RECIPIENT_INVALID. The page: not "Tasdiqlandi", the username still there, and
    // the way out is the lookup, not a retry with the dead token.
    await expect(page.getByText(t('uz').recipient.expired)).toBeVisible();
    await expect(usernameField(page)).toHaveValue('aziz_k');
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: false });
    await expect(page.getByText(t('uz').recipient.unconfirmed)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(api.quoteBodies).toHaveLength(2); // the first, and the refresh: nothing by itself
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await attachShot(page, testInfo, 'recipient-expired');

    await confirmRecipient(page, 'uz', 'aziz_k');
    await expect.poll(() => api.quoteBodies.length).toBe(3);
    // The third request carries the second token, not the dead one.
    expect(api.quoteBodies[2]?.['recipientToken']).toBe(tokenN(2));
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
    expect(api.recipientBodies).toHaveLength(2);
  });
});

test.describe('"Qanday topaman?"', () => {
  test('the catalog text is shown as text only, and the native BackButton closes the sheet', async ({
    page,
  }, testInfo) => {
    await openProduct(page, STARS, { product: { help: true } });
    await page.getByRole('button', { name: t('uz').help.open }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The markup in the text is shown as characters; it did not become an element or run.
    await expect(dialog).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(dialog.locator('img')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    await attachShot(page, testInfo, 'help-sheet');

    await tgPressBack(page);
    await expect(dialog).toBeHidden();
    // Still on the product page: the BackButton closed the sheet instead of leaving.
    await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
    expect(await tgCallNames(page)).toContain('BackButton.show');
  });
});
