import { expect, test } from '@playwright/test';
import { TOKEN } from '../fixtures/product';
import { tgCallNames, tgPressBack, tgPressMain } from '../fixtures/telegram';
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
} from './product-support';
import { axeViolations, overflow } from './support';

// The Mini App product page for Telegram Stars (phase 7 S6): the recipient, the quantity, the quote
// and the native MainButton. The page and recipient states are in product-states.spec.ts.

const STARS = 'telegram-stars';
// 50 stars at the fake server's 220 so'm each, as the server wrote it (a narrow no-break space).
const ELEVEN_THOUSAND = '11.000';
const TWENTY_TWO_THOUSAND = '22.000';

test.describe('ready', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: header, recipient form, quantity, summary, MainButton off`, async ({
        page,
      }, testInfo) => {
        const t = TEXT[lang].store.product;
        await openProduct(page, STARS, { lang, scheme });

        await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
        await expect(
          page.getByRole('heading', { level: 2, name: t.recipient.title }),
        ).toBeVisible();
        await expect(usernameField(page)).toBeVisible();
        await expect(page.getByRole('textbox', { name: t.qty.label })).toHaveValue('50');
        await expect(page.getByRole('group', { name: t.qty.presets })).toBeVisible();
        await expect(page.getByText(/220/).first()).toBeVisible(); // 1 ⭐ ≈ 220 so'm, labelled approximate

        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        // The native button is shown, off, and the page says why (the native one has no room).
        await expect
          .poll(() => mainButton(page))
          .toMatchObject({
            text: TEXT[lang].store.product.buy.label,
            enabled: false,
            visible: true,
          });
        await expect(page.getByText(t.buy.needRecipient)).toBeVisible();

        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await attachShot(page, testInfo, `product-stars-${lang}-${scheme}`);
      });
    }
  }

  test('no console error, no CSP violation, no request to another origin', async ({ page }) => {
    const problems = watchPage(page);
    const origins = new Set<string>();
    page.on('request', (request) => origins.add(new URL(request.url()).origin));
    await openProduct(page, STARS);
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
    expect(unexpectedProblems(problems)).toEqual([]);
    expect([...origins].sort()).toEqual(
      ['http://localhost:3100', 'http://localhost:5000', 'https://telegram.org'].sort(),
    );
  });

  test('the native BackButton is shown on the product page and goes back to the home page', async ({
    page,
  }) => {
    await openProduct(page, STARS);
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
    await expect.poll(() => tgCallNames(page)).toContain('BackButton.show');
    await tgPressBack(page);
    await expect(page).toHaveURL(/\/tg$/);
  });
});

test.describe('buying', () => {
  test('MainButton turns on only with a confirmed recipient and a live quote, with the server price', async ({
    page,
  }) => {
    const api = await openProduct(page, STARS);
    const t = TEXT.uz.store.product;
    await expect(page.getByRole('textbox', { name: t.qty.label })).toBeVisible();
    expect(api.quoteBodies).toHaveLength(0);

    await usernameField(page).fill('@aziz_k');
    await page.getByRole('button', { name: t.recipient.check, exact: true }).click();
    // The server found a person; until the visitor says "yes" there is still no price.
    await expect(page.getByText(t.recipient.prompt)).toBeVisible();
    await expect(page.getByText('Aziz', { exact: true })).toBeVisible();
    expect(api.recipientBodies).toEqual([
      { productId: 'id_telegram_stars', input: { username: 'aziz_k' } },
    ]);
    expect(api.quoteBodies).toHaveLength(0);
    expect((await mainButton(page)).enabled).toBe(false);

    await page.getByRole('button', { name: t.recipient.confirm, exact: true }).click();
    await expect
      .poll(() => api.quoteBodies)
      .toEqual([{ productId: 'id_telegram_stars', quantity: 50, recipientToken: TOKEN }]);
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({
        enabled: true,
        progress: false,
        text: expect.stringMatching(new RegExp(`${ELEVEN_THOUSAND}\\s*so‘m`)),
      });
    await expect(page.getByText(/kafolatlangan/)).toBeVisible();
    await expect(page.getByRole('region', { name: t.summary.label })).toContainText('@aziz_k');

    // A press reaches the page's handler (the order sheet is S7): nothing breaks.
    await tgPressMain(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
  });

  test('a changed username takes the confirmation, the price and the button away', async ({
    page,
  }) => {
    const api = await openProduct(page, STARS);
    const t = TEXT.uz.store.product;
    await confirmRecipient(page);
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });

    await page.getByRole('button', { name: t.recipient.change, exact: true }).click();
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: false });
    await expect(page.getByText(t.recipient.unconfirmed)).toBeVisible();
    await usernameField(page).fill('aziz_kk');
    await expect(page.getByRole('button', { name: t.recipient.confirm, exact: true })).toHaveCount(
      0,
    );
    expect((await mainButton(page)).enabled).toBe(false);
    expect(api.quoteBodies).toHaveLength(1); // nothing new was asked
  });

  test('quantity: below the minimum is an error with no request; a quick pick asks once, debounced', async ({
    page,
  }) => {
    const api = await openProduct(page, STARS);
    const t = TEXT.uz.store.product;
    await confirmRecipient(page);
    await expect.poll(() => api.quoteBodies.length).toBe(1);

    const qty = page.getByRole('textbox', { name: t.qty.label });
    await qty.fill('10');
    await expect(page.getByText(/50 dan 100.000 gacha/)).toBeVisible();
    await expect.poll(() => mainButton(page)).toMatchObject({ enabled: false });
    await expect(page.getByText(t.buy.needPackage)).toBeVisible();

    // Typing digit by digit is one request, for the last value.
    await qty.fill('');
    await qty.pressSequentially('250', { delay: 40 });
    await expect.poll(() => api.quoteBodies.length, { timeout: 5000 }).toBe(2);
    expect(api.quoteBodies[1]).toMatchObject({ quantity: 250 });

    await page.getByRole('button', { name: '100 ⭐', exact: true }).click();
    await expect.poll(() => api.quoteBodies.length, { timeout: 5000 }).toBe(3);
    expect(api.quoteBodies[2]).toMatchObject({ quantity: 100 });
    await expect
      .poll(() => mainButton(page))
      .toMatchObject({
        enabled: true,
        text: expect.stringMatching(new RegExp(`${TWENTY_TWO_THOUSAND}\\s*so‘m`)),
      });
    expect(await tgCallNames(page)).toContain('HapticFeedback.selectionChanged');
  });

  test('"O‘zim" fills the visitor\'s own username', async ({ page }) => {
    await openProduct(page, STARS);
    await page.getByRole('button', { name: TEXT.uz.store.product.recipient.self }).click();
    await expect(usernameField(page)).toHaveValue('sardor_r');
  });
});
