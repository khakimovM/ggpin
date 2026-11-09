import { expect, test } from '@playwright/test';
import { tgPressMain } from '../fixtures/telegram';
import { watchPage } from '../support/gallery';
import { unexpectedProblems } from '../support/fake-api';
import { TEXT, install, mainButton } from '../tg/checkout-support';
import { confirmRecipient } from '../tg/product-support';
import { axeViolations, overflow } from '../tg/support';

// Journey 2: buying Telegram Stars in the Mini App (phase 7 S7, the mocked part): home -> Stars ->
// @username -> confirmation -> pay. The API is faked with `page.route`; the wallet top-up step
// does not exist before S8, so the "not enough money" ending stops at the sheet and the funded
// ending (`j2-stars-purchase-funded`) runs the order to its delivery.

const t = TEXT.uz.store;

async function toConfirmation(page: import('@playwright/test').Page) {
  await page.goto('/tg');
  await page.getByRole('link', { name: /Telegram Stars/ }).click();
  await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
  await confirmRecipient(page, 'uz', 'aziz_k');
  await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
  await tgPressMain(page); // opens the confirmation
  await expect(page.getByRole('dialog', { name: t.checkout.confirm.title })).toBeVisible();
}

test('j2-stars-purchase: not enough money ends in the "Mablag‘ yetarli emas" sheet, nothing is bought', async ({
  page,
}) => {
  const problems = watchPage(page);
  const { orders } = await install(page, { orders: { balanceTiyin: '1000000' } }); // 10 000 so'm
  await toConfirmation(page);
  await tgPressMain(page); // pay
  const sheet = page.getByRole('dialog', { name: t.checkout.insufficient.title });
  await expect(sheet).toContainText(/10.000\s*so‘m/); // balance
  await expect(sheet).toContainText(/11.000\s*so‘m/); // price
  await expect(sheet).toContainText(/1.000\s*so‘m/); // shortfall, the server's
  await expect(sheet.getByRole('button', { name: t.checkout.insufficient.topup })).toBeEnabled();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
  expect(orders.posts).toHaveLength(1);
  await sheet.getByRole('button', { name: t.checkout.insufficient.close }).last().click();
  await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
  expect(unexpectedProblems(problems)).toEqual([]);
});

test('j2-stars-purchase-funded: enough money - pay, processing, delivered', async ({ page }) => {
  const problems = watchPage(page);
  const { orders } = await install(page, {});
  await toConfirmation(page);
  await tgPressMain(page); // pay
  await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
  await expect(
    page.getByRole('heading', { level: 1, name: t.order.hero.paid.title }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: t.order.hero.processing.title }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { level: 1, name: /Yetkazildi!/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/@aziz_k hisobiga 50 ⭐ tushdi/)).toBeVisible();
  expect(orders.posts).toHaveLength(1);
  expect(await axeViolations(page)).toEqual([]);
  expect(unexpectedProblems(problems)).toEqual([]);
});
