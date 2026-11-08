import { expect, test, type Page } from '@playwright/test';
import { TOKEN } from '../fixtures/product';
import { unexpectedProblems } from '../support/fake-api';
import { watchPage } from '../support/gallery';
import {
  SCHEMES,
  TEXT,
  attachShot,
  confirmRecipient,
  mainButton,
  openProduct,
  usernameField,
  type Lang,
} from './product-support';
import { axeViolations, overflow } from './support';

// The Mini App product page for Telegram Premium (phase 7 S6): the terms as the catalog labels them,
// the quote for the chosen package, and the blocked recipient. Stars are in product-stars.spec.ts.

const PREMIUM = 'telegram-premium';
const LABELS: Record<Lang, string[]> = {
  uz: ['3 oylik', '6 oylik', '12 oylik'],
  ru: ['3 месяца', '6 месяцев', '12 месяцев'],
};
const term = (page: Page, lang: Lang) =>
  page.getByRole('radiogroup', { name: TEXT[lang].store.product.sku.plans });

test.describe('ready', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: three terms, none chosen, MainButton off`, async ({
        page,
      }, testInfo) => {
        const t = TEXT[lang].store.product;
        await openProduct(page, PREMIUM, { lang, scheme });
        await expect(
          page.getByRole('heading', { level: 1, name: 'Telegram Premium' }),
        ).toBeVisible();

        const radios = term(page, lang).getByRole('radio');
        await expect(radios).toHaveCount(3);
        for (const [index, label] of LABELS[lang].entries()) {
          await expect(radios.nth(index)).toContainText(label);
          await expect(radios.nth(index)).not.toBeChecked();
        }
        // The catalog's own display prices on the tiles.
        await expect(radios.nth(0)).toContainText(/165.000/);
        await expect(radios.nth(2)).toContainText(/396.000/);

        await expect
          .poll(() => mainButton(page))
          .toMatchObject({ text: t.buy.label, enabled: false, visible: true });
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await attachShot(page, testInfo, `product-premium-${lang}-${scheme}`);
      });
    }
  }

  test('no console error and no CSP violation', async ({ page }) => {
    const problems = watchPage(page);
    await openProduct(page, PREMIUM);
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Premium' })).toBeVisible();
    expect(unexpectedProblems(problems)).toEqual([]);
  });
});

test.describe('buying', () => {
  test('a quote is asked for only after a term is chosen, with the package id', async ({
    page,
  }) => {
    const api = await openProduct(page, PREMIUM);
    await confirmRecipient(page);
    // Recipient confirmed, nothing chosen: no quote, the page says what is missing.
    await expect(page.getByText(TEXT.uz.store.product.buy.needPackage)).toBeVisible();
    expect(api.quoteBodies).toHaveLength(0);
    expect((await mainButton(page)).enabled).toBe(false);

    await term(page, 'uz')
      .getByRole('radio', { name: /6 oylik/ })
      .click();
    await expect
      .poll(() => api.quoteBodies)
      .toEqual([{ productId: 'id_telegram_premium', skuId: 'm6', recipientToken: TOKEN }]);
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: expect.stringMatching(/220.000\s*so‘m/) });

    // Another term is another quote, at once (no debounce for a package), and its price replaces
    // the old one.
    await term(page, 'uz')
      .getByRole('radio', { name: /12 oylik/ })
      .click();
    await expect.poll(() => api.quoteBodies.length).toBe(2);
    expect(api.quoteBodies[1]).toMatchObject({ skuId: 'm12' });
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({ enabled: true, text: expect.stringMatching(/396.000\s*so‘m/) });
  });

  test('the arrow keys move the choice, and Tab leaves the group', async ({ page }) => {
    await openProduct(page, PREMIUM);
    const radios = term(page, 'uz').getByRole('radio');
    await radios.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(1)).toBeChecked();
    await expect(radios.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(radios.nth(0)).toBeChecked();
    await page.keyboard.press('ArrowUp'); // wraps to the last
    await expect(radios.nth(2)).toBeChecked();
  });

  test('a recipient who cannot get Premium blocks the purchase with its own message', async ({
    page,
  }, testInfo) => {
    const t = TEXT.uz.store.product;
    const api = await openProduct(page, PREMIUM, {
      product: { recipients: { prem_user: 'hasPremium' } },
    });
    await term(page, 'uz')
      .getByRole('radio', { name: /3 oylik/ })
      .click();
    await usernameField(page).fill('prem_user');
    await page.getByRole('button', { name: t.recipient.check, exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: t.recipient.blocked.title }),
    ).toBeVisible();
    expect(api.quoteBodies).toHaveLength(0);
    expect((await mainButton(page)).enabled).toBe(false);
    await attachShot(page, testInfo, 'premium-blocked');
  });
});
