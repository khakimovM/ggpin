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
import { saveShot } from '../store/shot-file';
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

// Phase 6 P6-W1: the three "already has Premium" states (owner decision Q1) and the term rows
// ("{price}/oy", "Eng foydali" on the lowest price per month, Q6). With SHOTS_DIR set, the
// screenshots are also written there for the comparison with Product.dc.html.
const STATES = { none: 'aziz_k', has: 'prem_ext', blocked: 'prem_user' } as const;
const PER_MONTH: Record<Lang, RegExp[]> = {
  uz: [/55.000\s*so‘m\/oy/, /36.700\s*so‘m\/oy/, /33.000\s*so‘m\/oy/],
  ru: [/55.000\s*сум\/мес/, /36.700\s*сум\/мес/, /33.000\s*сум\/мес/],
};

test.describe('premium states', () => {
  for (const state of ['none', 'has', 'blocked'] as const) {
    for (const lang of ['uz', 'ru'] as const) {
      for (const scheme of SCHEMES) {
        test(`${state} / ${lang} / ${scheme}`, async ({ page }, testInfo) => {
          const t = TEXT[lang];
          const r = t.store.product.recipient;
          await openProduct(page, PREMIUM, {
            lang,
            scheme,
            product: { recipients: { prem_ext: 'hasPremiumExtends', prem_user: 'hasPremium' } },
          });
          const radios = term(page, lang).getByRole('radio');
          for (const [index, perMonth] of PER_MONTH[lang].entries()) {
            await expect(radios.nth(index)).toContainText(perMonth);
          }
          const best = t.store.product.sku.best;
          await expect(radios.nth(2).getByText(best, { exact: true })).toBeVisible();
          await expect(page.getByText(best, { exact: true })).toHaveCount(1);
          await radios.nth(1).click();

          await usernameField(page).fill(STATES[state]);
          await page.getByRole('button', { name: r.check, exact: true }).click();
          const note = page.getByRole('status').filter({ hasText: t.warnings.premiumExtends });
          if (state === 'blocked') {
            await expect(
              page.getByRole('alert').filter({ hasText: r.blocked.title }),
            ).toBeVisible();
            await expect(note).toHaveCount(0);
            await expect.poll(() => mainButton(page)).toMatchObject({ enabled: false });
          } else {
            // Found: the note (if any) is shown before the visitor confirms, and stays after.
            await expect(page.getByRole('button', { name: r.confirm, exact: true })).toBeVisible();
            await expect(note).toHaveCount(state === 'has' ? 1 : 0);
            await page.getByRole('button', { name: r.confirm, exact: true }).click();
            await expect(note).toHaveCount(state === 'has' ? 1 : 0);
            await expect
              .poll(() => mainButton(page))
              .toMatchObject({ enabled: true, text: expect.stringMatching(/220.000/) });
          }
          expect(await overflow(page)).toBeLessThanOrEqual(0);
          expect(await axeViolations(page)).toEqual([]);
          const name = `tg-premium-${state}-${lang}-${scheme}`;
          await attachShot(page, testInfo, name);
          if (process.env.SHOTS_DIR) await saveShot(page, process.env.SHOTS_DIR, name);
        });
      }
    }
  }
});
