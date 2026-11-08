import { expect, test, type Page } from '@playwright/test';
import { PREMIUM_PRICE } from '../fixtures/product';
import { unexpectedProblems } from '../support/fake-api';
import { watchPage } from '../support/gallery';
import { openStoreProduct, TEXT } from '../store/checkout-support';
import { confirmRecipient } from '../store/product-support';
import { axeViolations, overflow } from '../tg/support';

// Journey 3: Telegram Premium in the web store (phase 7 S7, the mocked part): the three terms and
// their prices from the server, then the language switch uz <-> ru on the same page. The order
// history (S9) is not built yet, so that step joins this journey with S9.

const uz = TEXT.uz;
const ru = TEXT.ru;
const narrow = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;

async function reveal(page: Page, t: typeof uz) {
  if (narrow(page)) await page.getByRole('button', { name: t.web.nav.menu }).click();
}

test('j3-premium-history-lang: 3 / 6 / 12 months, each with the server price, then uz -> ru -> uz', async ({
  page,
}) => {
  const problems = watchPage(page);
  const { product } = await openStoreProduct(page, 'telegram-premium');
  await confirmRecipient(page, 'uz', 'aziz_k');

  const terms = page
    .getByRole('radiogroup', { name: uz.store.product.sku.plans })
    .getByRole('radio');
  const summary = page.getByRole('region', { name: uz.store.product.summary.label });
  const expected = [
    ['3 oylik', 'm3', /165.000\s*so‘m/],
    ['6 oylik', 'm6', /220.000\s*so‘m/],
    ['12 oylik', 'm12', /396.000\s*so‘m/],
  ] as const;
  for (const [index, [label, skuId, total]] of expected.entries()) {
    await terms.nth(index).click();
    await expect(terms.nth(index)).toBeChecked();
    await expect(summary).toContainText(label);
    await expect(summary).toContainText(total);
    // The figure on screen is the one the server wrote for that package.
    expect([...product.quotes.values()].at(-1)?.totalTiyin).toBe(PREMIUM_PRICE[skuId]);
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);

  await reveal(page, uz);
  await page.getByRole('radio', { name: uz.web.nav.langRu }).click();
  await expect(page).toHaveURL(/\/ru\/store\/products\/telegram-premium$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const ruTerms = page
    .getByRole('radiogroup', { name: ru.store.product.sku.plans })
    .getByRole('radio');
  await expect(ruTerms).toHaveText([/3 месяца/, /6 месяцев/, /12 месяцев/]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await reveal(page, ru);
  await page.getByRole('radio', { name: ru.web.nav.langUz }).click();
  await expect(page).toHaveURL(/\/store\/products\/telegram-premium$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'uz');
  expect(unexpectedProblems(problems)).toEqual([]);
});
