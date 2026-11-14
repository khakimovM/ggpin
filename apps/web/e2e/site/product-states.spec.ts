import { expect, test } from '@playwright/test';
import { E2E_BOT_URL, E2E_DEGRADED_SITE_URL, E2E_SPARSE_SITE_URL } from '../support/app-env';
import { overflow } from '../tg/support';
import { jsonLdBlocks } from './landing-support';
import {
  openProduct,
  PRODUCT_LANGS,
  PRODUCTS,
  productCopy,
  productPath,
  type ProductLang,
} from './product-support';
import { seriousViolations } from './shell-support';

// The states of a product page that need a catalog of their own (phase 8 S3, P8-Q20). The site
// keeps a catalog answer for 60 s, so each lives on its own pair of servers (playwright.config.ts):
//  - the degraded pair: the catalog always answers 500, so the product is "unknown";
//  - the thin pair: the catalog is up, Stars has no packages and Premium is a 404.

const PRICE = /\d\s(?:so‘m|сум)/;
// Premium is a 404 in the thin catalog, so none of the main fixture's Premium prices may appear.
const PRICE_NEAR_PREMIUM = /165\s000/;

for (const lang of ['uz', 'ru'] as const satisfies ProductLang[]) {
  const { store } = PRODUCT_LANGS[lang];

  test.describe(`${lang}: the catalog is down`, () => {
    test.use({ baseURL: E2E_DEGRADED_SITE_URL });

    for (const { slug, key, name } of PRODUCTS) {
      const { own, common } = productCopy(key, lang);

      test(`${slug}: a whole page without a price, and the way to the store stays`, async ({
        page,
        request,
      }) => {
        expect((await request.get(productPath(slug, lang))).status()).toBe(200);
        await openProduct(page, slug, lang);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
        const main = page.getByRole('main');
        await expect(page.getByText(own.lead)).toBeVisible();
        // No price anywhere, no package list, a note saying so; no error banner, no retry.
        expect(await main.innerText()).not.toMatch(PRICE);
        await expect(page.getByRole('radiogroup')).toHaveCount(0);
        await expect(page.getByText(common.packages.noPrices)).toBeVisible();
        await expect(main.getByRole('alert')).toHaveCount(0);
        await expect(main.getByRole('button')).toHaveCount(0);
        // The buy button stays and leads into the store; so does the bot.
        await expect(main.getByRole('link', { name: common.buy.label })).toHaveAttribute(
          'href',
          `${store}/products/${slug}`,
        );
        await expect(main.getByRole('link', { name: common.telegram })).toHaveAttribute(
          'href',
          E2E_BOT_URL,
        );
      });

      test(`${slug}: the metadata and the structured data do not depend on the catalog`, async ({
        page,
      }) => {
        await openProduct(page, slug, lang);
        await expect(page.locator('meta[name="description"]')).toHaveAttribute(
          'content',
          own.meta.description,
        );
        const blocks = await jsonLdBlocks(page);
        expect(blocks.map((block) => block.data['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
        // The other products come without prices as well, and are named.
        await expect(
          page.getByRole('heading', { level: 2, name: common.related.title }),
        ).toBeVisible();
      });

      test(`${slug}: axe finds nothing serious and nothing sticks out`, async ({ page }) => {
        await openProduct(page, slug, lang);
        expect(await seriousViolations(page)).toEqual([]);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      });
    }
  });

  test.describe(`${lang}: a thin catalog`, () => {
    test.use({ baseURL: E2E_SPARSE_SITE_URL });

    test('Stars with no packages: the minimum and a note, the buy button still leads to the store', async ({
      page,
      request,
    }) => {
      const { common } = productCopy('stars', lang);
      expect((await request.get(productPath('telegram-stars', lang))).status()).toBe(200);
      await openProduct(page, 'telegram-stars', lang);
      const main = page.getByRole('main');
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      // The note names the minimum the API sent, and no price is invented for the missing packages.
      const note = main.locator('p', { hasText: /50\s⭐/ }).first();
      await expect(note).toHaveText(
        PRODUCT_LANGS[lang].site.product.stars.packages.noPackagesMin.replace(
          '{min, number}',
          '50',
        ),
      );
      await expect(main.getByRole('link', { name: common.buy.label })).toHaveAttribute(
        'href',
        `${store}/products/telegram-stars`,
      );
      // The cards still say what the API knows: the price of a star and the minimum.
      await expect(main.locator('dl')).toContainText(/1 ⭐ = 220\s+(?:so‘m|сум)/);
      await expect(main.locator('dl')).toContainText(/50 ⭐/);
      expect(await seriousViolations(page)).toEqual([]);
    });

    test('Premium that the catalog does not have: "not available", the button disabled, HTTP 200', async ({
      page,
      request,
    }) => {
      const { own, common } = productCopy('premium', lang);
      const response = await request.get(productPath('telegram-premium', lang));
      expect(response.status()).toBe(200);
      await openProduct(page, 'telegram-premium', lang);
      const main = page.getByRole('main');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Telegram Premium');
      await expect(page.getByText(common.unavailable.title)).toBeVisible();
      await expect(page.getByText(common.unavailable.body)).toBeVisible();
      await expect(main.getByRole('button', { name: common.buy.label })).toBeDisabled();
      await expect(main.getByRole('link', { name: common.buy.label })).toHaveCount(0);
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      // The page is still a page: its questions, and the other products to go on with.
      await expect(page.getByRole('heading', { level: 2, name: own.faq.title })).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: common.related.title }),
      ).toBeVisible();
      expect(await main.innerText()).not.toMatch(PRICE_NEAR_PREMIUM);
      expect(await seriousViolations(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
