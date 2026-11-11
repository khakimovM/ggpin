import { expect, test, type Page } from '@playwright/test';
import { tgPressMain } from '../fixtures/telegram';
import {
  TEXT,
  attachShot,
  mainButton,
  openCheckout,
  reachConfirm,
  type Lang,
} from './checkout-support';

// A purchase whose answer never came (phase 7 S7 review, D-49): the attempt is written down before the
// request leaves, so a reload, another page of the same browser or a proxy's error page cannot make a
// second purchase.

const STARS = 'telegram-stars';
const t = (lang: Lang) => TEXT[lang].store.checkout;
const TOTAL = /11.000\s*(so‘m|сум)/;
const dialog = (page: Page, name?: string) =>
  page.getByRole('dialog', name === undefined ? {} : { name });

test.describe('a purchase in doubt survives the page', () => {
  test('the page is reloaded while the request is on its way: "result unknown", and the check carries the SAME key', async ({
    page,
  }, testInfo) => {
    const { orders } = await openCheckout(page, STARS, { orders: { post: 'hangOnce' } });
    await reachConfirm(page);
    await tgPressMain(page); // pay: the server makes the order, the answer never comes
    await expect.poll(() => orders.posts.length).toBe(1);

    await page.reload(); // the record was written BEFORE the request left
    await reachConfirm(page);
    const sheet = dialog(page);
    await expect(sheet.getByText(t('uz').uncertain.title)).toBeVisible();
    await expect(sheet).toContainText('Telegram Stars · 50 ⭐'); // which purchase, no amount
    await expect(sheet).not.toContainText(TOTAL);
    await attachShot(page, testInfo, 'uncertain-after-reload-uz');
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: t('uz').uncertain.retry });
    await tgPressMain(page);
    await expect(page).toHaveURL(/\/tg\/orders\/order_1$/); // the order the first request made
    expect(orders.posts).toHaveLength(2);
    expect(orders.posts[1]).toEqual(orders.posts[0]);
  });

  test('a second page of the same browser sees it at once, without a reload', async ({
    page,
    context,
  }) => {
    const first = await openCheckout(page, STARS);
    await reachConfirm(page); // the sheet is open and ready to pay
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: expect.stringMatching(TOTAL) });

    const second = await context.newPage();
    const other = await openCheckout(second, STARS, { orders: { post: 'hangOnce' } });
    await reachConfirm(second);
    await tgPressMain(second);
    await expect.poll(() => other.orders.posts.length).toBe(1);

    await expect(dialog(page).getByText(t('uz').uncertain.title)).toBeVisible();
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: t('uz').uncertain.retry });
    expect(first.orders.posts).toHaveLength(0); // this page paid nothing
  });

  test('a proxy\'s HTML 404 is not an answer: it stays "result unknown" with the same key', async ({
    page,
  }) => {
    const { orders } = await openCheckout(page, STARS, { orders: { post: 'proxy404' } });
    await reachConfirm(page);
    await tgPressMain(page);
    await expect(dialog(page).getByText(t('uz').uncertain.title)).toBeVisible();
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: t('uz').uncertain.retry });
    await tgPressMain(page); // the check meets the proxy's 404 page again
    await expect.poll(() => orders.posts.length).toBe(2);
    await expect(dialog(page).getByText(t('uz').uncertain.title)).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: t('uz').expired.renew })).toHaveCount(0);
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: t('uz').uncertain.retry });

    orders.setPost('ok'); // the proxy is fixed
    await tgPressMain(page);
    await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
    expect(orders.posts).toHaveLength(3);
    expect(orders.posts[1]).toEqual(orders.posts[0]);
    expect(orders.posts[2]).toEqual(orders.posts[0]);
  });
});
