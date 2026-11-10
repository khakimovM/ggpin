import { expect, test, type Locator, type Page } from '@playwright/test';
import { focusIsVisible, isBlocking, scan } from './qa-support';
import { openStoreProduct, TEXT } from '../store/checkout-support';
import { buyButton, usernameField } from '../store/product-support';

// Phase 7 S11, check 3: the whole web purchase with the keyboard only (Tab / Shift+Tab / Enter /
// Space / Escape; no pointer): catalog -> Telegram Stars -> @username -> confirm -> pay -> order.
// The Mini App buys with Telegram's own MainButton, which is not part of the page, so the web
// store is where the keyboard path can be proved.

const t = TEXT.uz;
const STARS = 'telegram-stars';

/** Presses Tab until `target` has the focus; fails if the focus walks past it or is trapped. */
async function tabTo(page: Page, target: Locator, label: string, limit = 80) {
  for (let step = 0; step < limit; step += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached "${label}" in ${limit} presses`);
}

test('web store: the purchase with the keyboard only, every focus stop visible', async ({
  page,
}) => {
  const unseen: string[] = [];
  const watch = async () => {
    const miss = await focusIsVisible(page);
    if (miss !== null) unseen.push(miss);
  };

  const { orders } = await openStoreProduct(page, STARS, { lang: 'uz' });
  // Start at the catalog like a visitor would: Tab to the Stars card, Enter.
  await page.goto('/store');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const starsCard = page.getByRole('link', { name: /Telegram Stars/ }).first();
  await tabTo(page, starsCard, 'the Stars card');
  await watch();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/store\/products\/telegram-stars$/);

  // @username, "Tekshirish" (check), "Ha, shu" (confirm).
  const field = usernameField(page);
  await tabTo(page, field, 'the username field');
  await watch();
  await page.keyboard.type('aziz_k');
  const check = page.getByRole('button', { name: t.store.product.recipient.check, exact: true });
  await tabTo(page, check, 'the check button');
  await watch();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('button', {
    name: t.store.product.recipient.confirm,
    exact: true,
  });
  await tabTo(page, confirm, 'the confirm button');
  await watch();
  await page.keyboard.press('Enter');

  // The package group is a radio group: an arrow key moves inside it, Tab leaves it.
  const buy = buyButton(page, 'uz');
  await expect(buy).toBeEnabled();
  await tabTo(page, buy, 'the buy button');
  await watch();
  await page.keyboard.press('Enter');

  // The confirmation: focus moves INTO the dialog, Tab stays in it (no leak), Enter pays.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.locator(':focus').count(), 'focus stays inside the open dialog').toBe(1);
    await watch();
  }
  const payButton = dialog.getByRole('button', {
    name: new RegExp(`^(${t.store.checkout.confirm.pay.split(' ')[0]})`),
  });
  await tabTo(page, payButton, 'the pay button');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/store\/orders\/order_1$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(orders.posts).toHaveLength(1);
  expect(unseen, 'focus stops without an outline or ring').toEqual([]);
  expect((await scan(page)).filter(isBlocking)).toEqual([]);
});
