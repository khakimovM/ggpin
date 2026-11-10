import { expect, test } from '@playwright/test';
import { installOrdersApi } from '../fixtures/orders';
import { installPaymentsApi } from '../fixtures/payments';
import { tgPressMain } from '../fixtures/telegram';
import { watchPage } from '../support/gallery';
import { escapeRegExp } from '../support/text';
import { unexpectedProblems } from '../support/fake-api';
import { TEXT, install, mainButton } from '../tg/checkout-support';
import { confirmRecipient } from '../tg/product-support';
import { axeViolations, overflow } from '../tg/support';

// Journey 2, the whole way (phase 7 S11): Mini App -> catalog -> Stars -> @username -> confirmed
// name -> "not enough money" sheet -> top-up (sandbox: the P2P fake) -> credited -> back to the
// purchase -> order processing -> delivered. The API is faked with `page.route`; the top-up
// credit is the fake server flipping the request to PAID, as the bank-feed matcher will.

const t = TEXT.uz;
const topup = t.tg.topup;
const delivered = t.store.order.hero.delivered;

test('j2-stars-topup-delivered: insufficient balance, top-up, then the order is delivered', async ({
  page,
}) => {
  const problems = watchPage(page);
  const { product } = await install(page, { orders: { balanceTiyin: '1000000' } }); // 10 000 so'm
  const payments = await installPaymentsApi(page, { creditedTiyin: '5034700' });

  // Catalog -> Stars.
  await page.goto('/tg');
  await page.getByRole('link', { name: /Telegram Stars/ }).click();
  await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
  await confirmRecipient(page, 'uz', 'aziz_k');
  await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
  await tgPressMain(page); // the confirmation
  await expect(page.getByRole('dialog', { name: t.store.checkout.confirm.title })).toBeVisible();
  await tgPressMain(page); // pay -> 422 INSUFFICIENT_BALANCE

  // Insufficient balance: the server's numbers, then the way to top up.
  const sheet = page.getByRole('dialog', { name: t.store.checkout.insufficient.title });
  await expect(sheet).toContainText(/11.000\s*so‘m/);
  await sheet.getByRole('button', { name: t.store.checkout.insufficient.topup }).click();
  await expect(page).toHaveURL(/\/tg\/topup\?from=%2Ftg%2Fproducts%2Ftelegram-stars$/);

  // Top-up: an amount, a card type, the request; the pay page opens in the browser.
  await page.getByRole('button', { name: '50 000' }).click();
  await page.getByRole('radio', { name: t.store.topup.cardType.humo }).click();
  await tgPressMain(page);
  await expect(page).toHaveURL(/\/tg\/topup\/cm3intent00000000000000001/);
  expect(payments.creates).toHaveLength(1);
  expect(payments.creates[0]).toMatchObject({ amountTiyin: '5000000', bank: 'HUMO' });

  // The bank notification arrives (fake): the request is credited, the wallet now covers the price.
  await installOrdersApi(page, product, { balanceTiyin: '6000000' }); // 60 000 so'm after credit
  payments.setStatus('PAID');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(topup.credited.title, {
    timeout: 15_000,
  });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);

  // Back to the purchase, pay again, and the order runs to its delivery.
  await page.getByRole('button', { name: topup.credited.buy }).click();
  await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
  await confirmRecipient(page, 'uz', 'aziz_k');
  await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
  await tgPressMain(page);
  await expect(page.getByRole('dialog', { name: t.store.checkout.confirm.title })).toBeVisible();
  await tgPressMain(page);
  await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
  await expect(
    page.getByRole('heading', { level: 1, name: t.store.order.hero.processing.title }),
  ).toBeVisible({ timeout: 15_000 });
  // "Yetkazildi! 🎉" and "@aziz_k hisobiga 50 ⭐ tushdi", from the catalog, not typed here.
  await expect(
    page.getByRole('heading', { level: 1, name: new RegExp(escapeRegExp(delivered.title)) }),
  ).toBeVisible({ timeout: 15_000 });
  const item = t.store.order.item.stars.replace('{count, number}', '50');
  const body = delivered.body.replace('{username}', 'aziz_k').replace('{item}', item);
  await expect(page.getByText(new RegExp(escapeRegExp(body)))).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  expect(unexpectedProblems(problems)).toEqual([]);
});
