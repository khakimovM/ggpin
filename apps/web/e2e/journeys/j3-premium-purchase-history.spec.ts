import { expect, test, type Page } from '@playwright/test';
import { PREMIUM_PRICE } from '../fixtures/product';
import { unexpectedProblems } from '../support/fake-api';
import { watchPage } from '../support/gallery';
import { escapeRegExp } from '../support/text';
import { openStoreProduct, TEXT } from '../store/checkout-support';
import { buyButton, confirmRecipient } from '../store/product-support';
import { axeViolations, overflow } from '../tg/support';

// Journey 3, the missing half (phase 7 S11): a Telegram Premium purchase in the web store, the
// order showing in the history, and the language switch uz -> ru on that history. The terms and
// their prices are in j3-premium-history-lang.spec.ts. The API is faked with `page.route`; the
// history list answers with the order the fake server just created (what the real one will do).

const uz = TEXT.uz;
const ru = TEXT.ru;
const narrow = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;

interface OrderView {
  id: string;
  number: number;
  productName: string;
  totalTiyin: string;
}

/** Answers `GET /orders` (the list) with the orders created so far. */
async function serveHistory(page: Page, created: OrderView[]) {
  await page.route(/^http:\/\/localhost:5000\/api\/v1\/orders(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3100';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({
        success: true,
        data: created,
        meta: { page: 1, limit: 20, total: created.length },
      }),
    });
  });
}

test('j3-premium-purchase-history: buy 12 months, the order is in the history, uz -> ru', async ({
  page,
}) => {
  const problems = watchPage(page);
  const created: OrderView[] = [];
  const { orders, product } = await openStoreProduct(page, 'telegram-premium');
  await serveHistory(page, created);
  page.on('response', async (response) => {
    if (response.request().method() !== 'POST' || !/\/orders$/.test(response.url())) return;
    const body = (await response.json()) as { data: { order: OrderView } };
    created.push(body.data.order);
  });

  // Pick the 12-month package, then pay.
  const terms = page
    .getByRole('radiogroup', { name: uz.store.product.sku.plans })
    .getByRole('radio');
  await confirmRecipient(page, 'uz', 'aziz_k');
  await terms.nth(2).click();
  await expect(terms.nth(2)).toBeChecked();
  const buy = buyButton(page, 'uz');
  await expect(buy).toBeEnabled();
  await buy.click();
  await expect(page.getByRole('dialog')).toContainText(/396.000\s*so‘m/);
  await page
    .getByRole('dialog')
    .getByRole('button', {
      name: new RegExp(`^${escapeRegExp(uz.store.checkout.confirm.pay.split(' ')[0] ?? '')}`),
    })
    .click();
  await expect(page).toHaveURL(/\/store\/orders\/order_1$/);
  expect(orders.posts).toHaveLength(1);
  expect([...product.quotes.values()].at(-1)?.totalTiyin).toBe(PREMIUM_PRICE['m12']);
  await expect.poll(() => created.length).toBe(1);

  // History: the order is the first row, with its product and total.
  await page.goto('/store/orders');
  const order = page.getByRole('link', {
    name: new RegExp(escapeRegExp(uz.store.order.item.premium.replace('{count}', '12'))),
  });
  await expect(order).toHaveAttribute('href', '/store/orders/order_1');
  await expect(page.getByRole('main')).toContainText(/#1001/);
  await expect(page.getByRole('main')).toContainText(/396.000/);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);

  // uz -> ru on the history: the URL, the document language and the table's headings change.
  if (narrow(page)) await page.getByRole('button', { name: uz.web.nav.menu }).click();
  await page.getByRole('radio', { name: uz.web.nav.langRu }).click();
  await expect(page).toHaveURL(/\/ru\/store\/orders$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(ru.account.history.title);
  await expect(page.getByRole('link', { name: /12 месяцев/ })).toHaveAttribute(
    'href',
    '/ru/store/orders/order_1',
  );
  await expect(page.getByRole('main')).toContainText(/#1001/);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(unexpectedProblems(problems)).toEqual([]);
});
