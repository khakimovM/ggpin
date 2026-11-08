import { expect, test, type Page } from '@playwright/test';
import { axeViolations, overflow } from '../tg/support';
import {
  SCHEMES,
  TEXT,
  prefix,
  reachStoreConfirm,
  openStoreProduct,
  shot,
  type Lang,
} from './checkout-support';
import { buyButton, confirmRecipient, TEN_MINUTES_MS } from './product-support';

// The web checkout (phase 7 S7): the confirmation (a bottom sheet below 768 px, a modal from it),
// paying with the button in the sheet, and every answer of POST /orders as its own screen.

const STARS = 'telegram-stars';
const t = (lang: Lang) => TEXT[lang].store.checkout;
const TOTAL = /11.000\s*(so‘m|сум)/;
const dialog = (page: Page, name?: string) =>
  page.getByRole('dialog', name === undefined ? {} : { name });
const pay = (page: Page, lang: Lang = 'uz') =>
  dialog(page).getByRole('button', { name: new RegExp(`^(${t(lang).confirm.pay.split(' ')[0]})`) });

test.describe('the confirmation', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: item, person, price, wallet before and after, the pay button`, async ({
        page,
      }, testInfo) => {
        await openStoreProduct(page, STARS, { lang, scheme });
        await reachStoreConfirm(page, lang);
        const sheet = dialog(page, t(lang).confirm.title);
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText('Telegram Stars · 50 ⭐');
        await expect(sheet).toContainText('@aziz_k · Aziz');
        await expect(sheet).toContainText(TOTAL);
        await expect(sheet).toContainText(/1.000.000\s*(so‘m|сум)\s*→\s*989.000\s*(so‘m|сум)/);
        await expect(pay(page, lang)).toBeEnabled();
        await expect(pay(page, lang)).toContainText(TOTAL);

        // A bottom sheet on a phone, a centred modal from 768 px.
        const box = await sheet.boundingBox();
        const viewport = page.viewportSize();
        if (box === null || viewport === null) throw new Error('no layout');
        if (viewport.width >= 768) expect(box.width).toBeLessThanOrEqual(480);
        else expect(box.width).toBeGreaterThan(viewport.width - 4);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `confirm-${lang}-${scheme}`);
      });
    }
  }

  test('only the keyboard: Enter opens it, Escape closes it and the focus goes back to the button', async ({
    page,
  }) => {
    await openStoreProduct(page, STARS);
    await confirmRecipient(page);
    const buy = buyButton(page, 'uz');
    await expect(buy).toBeEnabled();
    await buy.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator(':focus')).toHaveCount(1); // the focus is inside the sheet
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(buy).toBeFocused();
  });
});

test.describe('paying', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: one press, one order, and the order page of this language opens`, async ({
      page,
    }) => {
      const { orders } = await openStoreProduct(page, STARS, {
        lang,
        orders: { postDelayMs: 800 },
      });
      await reachStoreConfirm(page, lang);
      await pay(page, lang).dblclick();
      await expect(page).toHaveURL(new RegExp(`${prefix(lang)}/store/orders/order_1$`));
      expect(orders.posts).toHaveLength(1);
      expect(orders.posts[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }

  test('a network error: "result unknown", the SAME quote and key on the check, then the order', async ({
    page,
  }) => {
    const { orders } = await openStoreProduct(page, STARS, { orders: { post: 'networkOnce' } });
    await reachStoreConfirm(page);
    await pay(page).click();
    await expect(dialog(page).getByText(t('uz').uncertain.title)).toBeVisible();
    await expect(dialog(page).getByText(t('uz').failed.title)).toHaveCount(0);
    await dialog(page)
      .getByRole('button', { name: t('uz').uncertain.retry })
      .click();
    await expect(page).toHaveURL(/\/store\/orders\/order_1$/);
    expect(orders.posts).toHaveLength(2);
    expect(orders.posts[1]).toEqual(orders.posts[0]);
  });
});

test.describe('every answer of POST /orders', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: not enough money - the server's numbers, top-up not offered yet`, async ({
      page,
    }, testInfo) => {
      const text = t(lang).insufficient;
      await openStoreProduct(page, STARS, { lang, orders: { balanceTiyin: '500000' } });
      await reachStoreConfirm(page, lang);
      await pay(page, lang).click();
      const sheet = dialog(page, text.title);
      await expect(sheet).toContainText(/5.000\s*(so‘m|сум)/);
      await expect(sheet).toContainText(/11.000\s*(so‘m|сум)/);
      await expect(sheet).toContainText(/6.000\s*(so‘m|сум)/);
      await expect(sheet.getByRole('button', { name: text.topup })).toBeDisabled();
      await expect(sheet.getByText(text.soon)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `insufficient-${lang}`);
      await sheet.getByRole('button', { name: text.close }).last().click();
      await expect(dialog(page)).toHaveCount(0);
    });
  }

  test('410: a new price first, then the payment on the NEW quote with a new key', async ({
    page,
  }, testInfo) => {
    const { product, orders } = await openStoreProduct(page, STARS);
    await reachStoreConfirm(page);
    product.expireQuotes();
    await pay(page).click();
    await expect(dialog(page)).toContainText(/Narx yangilandi: 11.000\s*so‘m/);
    await shot(page, testInfo, 'confirm-expired-renewed');
    await dialog(page)
      .getByRole('button', { name: t('uz').expired.continue })
      .click();
    await pay(page).click();
    await expect(page).toHaveURL(/\/store\/orders\/order_1$/);
    expect(orders.posts).toHaveLength(2);
    expect(orders.posts[1]?.quoteId).not.toBe(orders.posts[0]?.quoteId);
    expect(orders.posts[1]?.key).not.toBe(orders.posts[0]?.key);
  });

  test('a price that ran out on the clock cannot be paid; the button renews it', async ({
    page,
  }) => {
    const { orders } = await openStoreProduct(page, STARS, { clock: true });
    await reachStoreConfirm(page);
    await page.clock.fastForward(TEN_MINUTES_MS + 30_000);
    await expect(dialog(page).getByText(t('uz').expired.title)).toBeVisible();
    await expect(pay(page)).toHaveCount(0);
    await dialog(page)
      .getByRole('button', { name: t('uz').expired.renew })
      .click();
    await expect(dialog(page)).toContainText(/Narx yangilandi/);
    expect(orders.posts).toHaveLength(0);
  });

  test('403 PURCHASE_FROZEN and any other error each say what happened', async ({ page }) => {
    await openStoreProduct(page, STARS, { orders: { post: 'frozen' } });
    await reachStoreConfirm(page);
    await pay(page).click();
    await expect(dialog(page, t('uz').frozen.title)).toContainText(/to‘lovingiz qaytarilgani/i);
    expect(await axeViolations(page)).toEqual([]);
  });

  test('429 on the order: its message, the sheet stays', async ({ page }) => {
    await openStoreProduct(page, STARS, { orders: { post: 'rateLimited' } });
    await reachStoreConfirm(page);
    await pay(page).click();
    await expect(dialog(page).getByText(/So‘rovlar juda ko‘p/)).toBeVisible();
  });
});
