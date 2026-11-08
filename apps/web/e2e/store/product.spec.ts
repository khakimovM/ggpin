import { expect, test } from '@playwright/test';
import { TOKEN } from '../fixtures/product';
import { unexpectedProblems } from '../support/fake-api';
import { watchPage } from '../support/gallery';
import { axeViolations, overflow } from '../tg/support';
import { openStore } from './catalog-support';
import {
  SCHEMES,
  TEXT,
  buyButton,
  confirmRecipient,
  openProductPage,
  prefix,
  shot,
  usernameField,
  wide,
  type Lang,
} from './product-support';

// The web store product page (phase 7 S6): breadcrumb, header, the recipient, the quantity or the
// terms, the summary and the buy action (a bottom bar below 1024 px, a sticky panel from 1024 px).
// API faked with `page.route`; the session is a fake signed-in one.

const STARS = 'telegram-stars';
const PREMIUM = 'telegram-premium';

test.describe('ready', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: breadcrumb, header, form, summary, one buy button`, async ({
        page,
      }, testInfo) => {
        const t = TEXT[lang].store.product;
        await openProductPage(page, STARS, { lang, scheme });

        const crumbs = page.getByRole('navigation', { name: t.breadcrumb });
        await expect(crumbs.getByRole('link', { name: t.catalog })).toHaveAttribute(
          'href',
          `${prefix(lang)}/store`,
        );
        await expect(crumbs.getByText('Telegram Stars')).toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
        await expect(
          page.getByRole('heading', { level: 2, name: t.recipient.title }),
        ).toBeVisible();
        await expect(page.getByRole('textbox', { name: t.qty.label })).toHaveValue('50');
        await expect(page.getByRole('region', { name: t.summary.label })).toBeVisible();

        // Exactly one buy button is on screen, off, and it says why.
        const buy = buyButton(page, lang);
        await expect(buy).toHaveCount(1);
        await expect(buy).toBeDisabled();
        await expect(buy).toHaveText(t.buy.needRecipient);

        // From 1024 px the form is a column on the right of the header, the button inside it;
        // below, one column with the button fixed to the bottom of the screen.
        const header = await page.getByRole('heading', { level: 1 }).boundingBox();
        const form = await page
          .getByRole('heading', { level: 2, name: t.recipient.title })
          .boundingBox();
        const button = await buy.boundingBox();
        if (header === null || form === null || button === null) throw new Error('no layout');
        if (wide(page)) {
          expect(form.x).toBeGreaterThan(header.x + header.width);
        } else {
          const height = page.viewportSize()?.height ?? 0;
          expect(button.y + button.height).toBeGreaterThan(height - 24);
        }

        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `product-stars-${lang}-${scheme}`);
      });
    }
  }

  test('no console error, no CSP violation, no request to another origin', async ({ page }) => {
    const problems = watchPage(page);
    const origins = new Set<string>();
    page.on('request', (request) => origins.add(new URL(request.url()).origin));
    await openProductPage(page, STARS);
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
    expect(unexpectedProblems(problems)).toEqual([]);
    expect([...origins].sort()).toEqual(['http://localhost:3100', 'http://localhost:5000'].sort());
  });

  test('a product card in the catalog leads here', async ({ page }) => {
    await openStore(page);
    await page.getByRole('link', { name: /Telegram Stars/ }).click();
    await expect(page).toHaveURL(/\/store\/products\/telegram-stars$/);
  });
});

test.describe('buying Stars', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: confirm the recipient, get the server price, the button turns on`, async ({
      page,
    }, testInfo) => {
      const t = TEXT[lang].store.product;
      const api = await openProductPage(page, STARS, { lang });
      await confirmRecipient(page, lang);
      await expect
        .poll(() => api.quoteBodies)
        .toEqual([{ productId: 'id_telegram_stars', quantity: 50, recipientToken: TOKEN }]);
      const buy = buyButton(page, lang);
      await expect(buy).toBeEnabled();
      await expect(buy).toHaveText(t.buy.label);
      // The total is the fake server's string: 50 stars * 220 so'm.
      await expect(page.getByRole('region', { name: t.summary.label })).toContainText(/11.000/);
      await expect(page.getByText(lang === 'uz' ? /kafolatlangan/ : /гарантирована/)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, testInfo, `product-confirmed-${lang}`);

      // Changing the username takes it all back.
      await page.getByRole('button', { name: t.recipient.change, exact: true }).click();
      await expect(buy).toBeDisabled();
      await expect(buy).toHaveText(t.buy.needRecipient);
    });
  }

  test('only the keyboard: type, Enter to look up, Tab to the confirmation, Enter', async ({
    page,
  }) => {
    const api = await openProductPage(page, STARS);
    const t = TEXT.uz.store.product;
    await usernameField(page).focus();
    await page.keyboard.type('aziz_k');
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('button', { name: t.recipient.confirm, exact: true });
    await expect(confirm).toBeVisible();
    await confirm.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => api.quoteBodies.length).toBe(1);
    await expect(buyButton(page, 'uz')).toBeEnabled();
  });

  test('a quantity outside the range is an error and asks for no price', async ({ page }) => {
    const api = await openProductPage(page, STARS);
    await confirmRecipient(page);
    await expect.poll(() => api.quoteBodies.length).toBe(1);
    await page.getByRole('textbox', { name: TEXT.uz.store.product.qty.label }).fill('7');
    await expect(page.getByText(/50 dan 100.000 gacha/)).toBeVisible();
    await expect(buyButton(page, 'uz')).toBeDisabled();
    await page.waitForTimeout(800);
    expect(api.quoteBodies).toHaveLength(1);
  });
});

test.describe('buying Premium', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: the terms, a quote for the chosen one`, async ({ page }, testInfo) => {
      const t = TEXT[lang].store.product;
      const labels: Record<Lang, string[]> = {
        uz: ['3 oylik', '6 oylik', '12 oylik'],
        ru: ['3 месяца', '6 месяцев', '12 месяцев'],
      };
      const api = await openProductPage(page, PREMIUM, { lang });
      const group = page.getByRole('radiogroup', { name: t.sku.plans });
      for (const [index, label] of labels[lang].entries()) {
        await expect(group.getByRole('radio').nth(index)).toContainText(label);
      }
      await confirmRecipient(page, lang);
      expect(api.quoteBodies).toHaveLength(0);
      await expect(buyButton(page, lang)).toHaveText(t.buy.needPackage);

      await group.getByRole('radio').nth(1).click();
      await expect
        .poll(() => api.quoteBodies)
        .toEqual([{ productId: 'id_telegram_premium', skuId: 'm6', recipientToken: TOKEN }]);
      await expect(buyButton(page, lang)).toBeEnabled();
      await expect(page.getByRole('region', { name: t.summary.label })).toContainText(/220.000/);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `product-premium-${lang}`);
    });
  }
});

test.describe('states', () => {
  test('skeleton while loading', async ({ page }, testInfo) => {
    const api = await openProductPage(page, STARS, { product: { product: 'slow' }, hold: true });
    await expect(page.getByRole('status')).toHaveText(TEXT.uz.store.product.loading);
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    await shot(page, testInfo, 'product-skeleton');
    api.release();
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
  });

  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: an error and its retry`, async ({ page }, testInfo) => {
      const t = TEXT[lang];
      const api = await openProductPage(page, STARS, { lang, product: { product: 'error' } });
      await expect(page.getByText(t.store.product.error.title)).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `product-error-${lang}`);
      api.setProduct('ok');
      await page.getByRole('button', { name: t.common.retry }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
    });

    test(`${lang}: unavailable (404) leads back to the catalog`, async ({ page }, testInfo) => {
      const t = TEXT[lang].store.product;
      await openProductPage(page, 'gone', { lang, product: { product: 'missing' } });
      await expect(page.getByText(t.unavailable.title)).toBeVisible();
      await expect(page.getByRole('link', { name: t.unavailable.cta })).toHaveAttribute(
        'href',
        `${prefix(lang)}/store`,
      );
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `product-unavailable-${lang}`);
    });
  }

  test('sold out: the header and nothing to buy', async ({ page }) => {
    await openProductPage(page, STARS, { product: { product: 'soldOut' } });
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
    await expect(page.getByText(TEXT.uz.store.product.unavailable.title)).toBeVisible();
    await expect(buyButton(page, 'uz')).toHaveCount(0);
  });

  test('every recipient message fits, in Russian too', async ({ page }, testInfo) => {
    for (const lang of ['uz', 'ru'] as const) {
      const text = TEXT[lang].store.product.recipient;
      await openProductPage(page, STARS, {
        lang,
        product: {
          recipients: { ghost_user: 'notFound', down_user: 'down', prem_user: 'hasPremium' },
        },
      });
      for (const [user, message] of [
        ['ghost_user', text.notFound],
        ['down_user', text.down],
        ['prem_user', text.blocked.title],
      ] as const) {
        await usernameField(page).fill(user);
        await page.getByRole('button', { name: text.check, exact: true }).click();
        await expect(page.getByText(message).first()).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await shot(page, testInfo, `recipient-${user}-${lang}`);
      }
    }
  });

  test('503 PRICE_UNAVAILABLE and an expired quote each have their note and button', async ({
    page,
  }) => {
    const t = TEXT.uz.store.product;
    const api = await openProductPage(page, STARS, {
      product: { quote: 'priceUnavailable', quoteTtlSec: 3 },
    });
    await confirmRecipient(page);
    await expect(page.getByText(t.quote.unavailable)).toBeVisible();
    await expect(buyButton(page, 'uz')).toBeDisabled();

    api.setQuote('ok');
    await page.getByRole('alert').getByRole('button', { name: TEXT.uz.common.retry }).click();
    await expect(buyButton(page, 'uz')).toBeEnabled();
    await expect(page.getByText(t.quote.expired, { exact: true }).first()).toBeVisible({
      timeout: 8000,
    });
    await expect(buyButton(page, 'uz')).toBeDisabled();
    await page.getByRole('button', { name: t.quote.refresh }).click();
    await expect.poll(() => api.quoteBodies.length).toBe(3);
  });
});

test.describe('"Qanday topaman?"', () => {
  test('a sheet with the catalog text as text, closed with Escape, the focus returned', async ({
    page,
  }, testInfo) => {
    const t = TEXT.uz.store.product;
    await openProductPage(page, STARS, { product: { help: true } });
    const open = page.getByRole('button', { name: t.help.open });
    await open.click();
    const dialog = page.getByRole('dialog', { name: t.help.title });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(dialog.locator('img')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, 'help-sheet');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
  });
});
