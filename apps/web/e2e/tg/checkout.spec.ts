import { expect, test, type Page } from '@playwright/test';
import { TEN_MINUTES_MS } from './product-support';
import { tgCallNames, tgPressMain } from '../fixtures/telegram';
import { axeViolations, overflow } from './support';
import {
  SCHEMES,
  TEXT,
  attachShot,
  mainButton,
  openCheckout,
  reachConfirm,
  type Lang,
} from './checkout-support';

// The Mini App checkout (phase 7 S7): the confirmation sheet, paying with Telegram's MainButton,
// and every answer of POST /orders as its own screen. The order page is in order.spec.ts.

const STARS = 'telegram-stars';
const t = (lang: Lang) => TEXT[lang].store.checkout;
// 50 stars at the fake server's 220 so'm each.
const TOTAL = /11.000\s*(so‘m|сум)/;
const dialog = (page: Page, name?: string) =>
  page.getByRole('dialog', name === undefined ? {} : { name });

test.describe('the confirmation', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: item, person, price, wallet before and after, the time left`, async ({
        page,
      }, testInfo) => {
        await openCheckout(page, STARS, { lang, scheme });
        await reachConfirm(page, lang);
        const sheet = dialog(page, t(lang).confirm.title);
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText('Telegram Stars · 50 ⭐');
        await expect(sheet).toContainText('@aziz_k · Aziz');
        await expect(sheet).toContainText(TOTAL);
        // 1 000 000 -> 989 000: the one display-only subtraction, from the server's strings.
        await expect(sheet).toContainText(/1.000.000\s*(so‘m|сум)\s*→\s*989.000\s*(so‘m|сум)/);
        await expect(sheet).toContainText(
          lang === 'uz' ? /Narx \d:\d\d daqiqa amal qiladi/ : /Цена действует \d:\d\d мин/,
        );

        // The action is Telegram's: pay with the price on it, and no button drawn in the sheet.
        await expect
          .poll(() => mainButton(page))
          .toMatchObject({ enabled: true, visible: true, text: expect.stringMatching(TOTAL) });
        await expect(sheet.getByRole('button', { name: /^(To‘lash|Оплатить)/ })).toHaveCount(0);

        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await attachShot(page, testInfo, `confirm-${lang}-${scheme}`);
      });
    }
  }

  test('closing it leaves the product page as it was, with nothing paid', async ({ page }) => {
    const { orders } = await openCheckout(page, STARS);
    await reachConfirm(page);
    await dialog(page)
      .getByRole('button', { name: t('uz').confirm.close })
      .click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
    expect(orders.posts).toHaveLength(0);
    // The product page's own button is back.
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: expect.stringMatching(/Sotib olish/) });
  });
});

test.describe('paying', () => {
  test('MainButton shows progress, a second press is ignored, one order, the order page opens', async ({
    page,
  }) => {
    const { orders } = await openCheckout(page, STARS, { orders: { postDelayMs: 1200 } });
    await reachConfirm(page);
    await tgPressMain(page); // pay (the first press opened the sheet)
    await expect.poll(() => mainButton(page)).toMatchObject({ progress: true });
    await tgPressMain(page);
    await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
    expect(orders.posts).toHaveLength(1);
    expect(orders.posts[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await tgCallNames(page)).toContain('HapticFeedback.notificationOccurred');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('a network error: "result unknown", the SAME quote and key on the check, then the order', async ({
    page,
  }) => {
    const { orders } = await openCheckout(page, STARS, { orders: { post: 'networkOnce' } });
    await reachConfirm(page);
    await tgPressMain(page); // pay (the first press opened the sheet)
    const sheet = dialog(page);
    await expect(sheet.getByText(t('uz').uncertain.title)).toBeVisible();
    // it may have gone through: never "payment failed"
    await expect(sheet.getByText(t('uz').failed.title)).toHaveCount(0);
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: t('uz').uncertain.retry });
    await tgPressMain(page);
    await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
    expect(orders.posts).toHaveLength(2);
    expect(orders.posts[1]).toEqual(orders.posts[0]); // same quote, same Idempotency-Key
  });

  test('the order exists but the answer was lost, and the price runs out meanwhile: the check still goes to the SAME quote and key, ONE order', async ({
    page,
  }, testInfo) => {
    const { orders } = await openCheckout(page, STARS, {
      clock: true,
      orders: { post: 'lostOnce' },
    });
    await reachConfirm(page);
    await tgPressMain(page); // pay: the server creates the order, the answer never arrives
    const sheet = dialog(page);
    await expect(sheet.getByText(t('uz').uncertain.title)).toBeVisible();
    await attachShot(page, testInfo, 'uncertain-uz');

    // ten minutes pass: the price is "expired" on the local clock, but nothing new is on offer
    await page.clock.fastForward(TEN_MINUTES_MS + 30_000);
    await expect(sheet.getByText(t('uz').uncertain.title)).toBeVisible();
    await expect(sheet.getByRole('button', { name: t('uz').expired.renew })).toHaveCount(0);
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: t('uz').uncertain.retry });
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await tgPressMain(page);
    // the order the first request made, not a second one
    await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
    expect(orders.posts).toHaveLength(2);
    expect(orders.posts[1]).toEqual(orders.posts[0]);
  });

  test('a lost answer, then the server has no such quote: only now is a new price offered', async ({
    page,
  }) => {
    const { product, orders } = await openCheckout(page, STARS, {
      orders: { post: 'networkOnce' },
    });
    await reachConfirm(page);
    await tgPressMain(page);
    await expect(dialog(page).getByText(t('uz').uncertain.title)).toBeVisible();
    product.expireQuotes(); // the server forgot the quote: it answers 410, so there is no order
    await tgPressMain(page);
    await expect(dialog(page).getByText(t('uz').uncertain.title)).toHaveCount(0);
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: t('uz').expired.continue });
    expect(orders.posts).toHaveLength(2);
  });
});

test.describe('every answer of POST /orders', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: not enough money - the server's numbers, a working top-up button, no buy-and-top-up`, async ({
      page,
    }, testInfo) => {
      const text = t(lang).insufficient;
      const { orders } = await openCheckout(page, STARS, {
        lang,
        orders: { balanceTiyin: '500000' }, // 5 000 so'm against 11 000
      });
      await reachConfirm(page, lang);
      await tgPressMain(page); // pay (the first press opened the sheet)
      const sheet = dialog(page, text.title);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(/5.000\s*(so‘m|сум)/); // balance
      await expect(sheet).toContainText(/11.000\s*(so‘m|сум)/); // price
      await expect(sheet).toContainText(/6.000\s*(so‘m|сум)/); // shortfall, written by the server
      await expect(sheet.getByRole('button', { name: text.topup })).toBeEnabled();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `insufficient-${lang}`);
      await sheet.getByRole('button', { name: text.close }).last().click();
      await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
      expect(orders.posts).toHaveLength(1);
    });
  }

  test('not enough money: the top-up button leaves for /tg/topup and remembers the product page', async ({
    page,
  }) => {
    await openCheckout(page, STARS, { orders: { balanceTiyin: '500000' } });
    await reachConfirm(page);
    await tgPressMain(page);
    const sheet = dialog(page, t('uz').insufficient.title);
    await sheet.getByRole('button', { name: t('uz').insufficient.topup }).click();
    await expect(page).toHaveURL(/\/tg\/topup\?from=%2Ftg%2Fproducts%2Ftelegram-stars$/);
  });

  test('410: a new price is shown first, and the payment goes on the NEW quote with a new key', async ({
    page,
  }, testInfo) => {
    const { product, orders } = await openCheckout(page, STARS);
    await reachConfirm(page);
    await expect(dialog(page)).toBeVisible();
    product.expireQuotes(); // the server no longer honours the quote on screen

    await tgPressMain(page);
    await expect(dialog(page).getByText(t('uz').expired.renewedBody)).toBeVisible();
    await expect(dialog(page)).toContainText(/Narx yangilandi: 11.000\s*so‘m/);
    await expect.poll(() => mainButton(page)).toMatchObject({ text: t('uz').expired.continue });
    await attachShot(page, testInfo, 'confirm-expired-renewed');

    await tgPressMain(page);
    await expect.poll(() => mainButton(page)).toMatchObject({ text: expect.stringMatching(TOTAL) });
    await tgPressMain(page);
    await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
    expect(orders.posts).toHaveLength(2);
    expect(orders.posts[1]?.quoteId).not.toBe(orders.posts[0]?.quoteId);
    expect(orders.posts[1]?.key).not.toBe(orders.posts[0]?.key);
  });

  test('a price that ran out on the clock cannot be paid; it is renewed first', async ({
    page,
  }) => {
    const { orders } = await openCheckout(page, STARS, { clock: true });
    await reachConfirm(page);
    await page.clock.fastForward(TEN_MINUTES_MS + 30_000);
    await expect(dialog(page).getByText(t('uz').expired.title)).toBeVisible();
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ text: t('uz').expired.renew, enabled: true });
    expect(orders.posts).toHaveLength(0);
    await tgPressMain(page);
    await expect(dialog(page)).toContainText(/Narx yangilandi/);
    await expect.poll(() => mainButton(page)).toMatchObject({ text: t('uz').expired.continue });
  });

  test('403 PURCHASE_FROZEN: why, and nothing to retry', async ({ page }, testInfo) => {
    await openCheckout(page, STARS, { orders: { post: 'frozen' } });
    await reachConfirm(page);
    await tgPressMain(page); // pay (the first press opened the sheet)
    const sheet = dialog(page, t('uz').frozen.title);
    await expect(sheet).toContainText(/to‘lovingiz qaytarilgani/i);
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'frozen');
    await sheet
      .getByRole('button', { name: t('uz').frozen.close })
      .last()
      .click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('any other error: its message, the sheet stays, the error haptic', async ({ page }) => {
    await openCheckout(page, STARS, { orders: { post: 'rateLimited' } });
    await reachConfirm(page);
    await tgPressMain(page); // pay (the first press opened the sheet)
    await expect(dialog(page).getByText(/So‘rovlar juda ko‘p/)).toBeVisible();
    expect(await tgCallNames(page)).toContain('HapticFeedback.notificationOccurred');
  });
});
