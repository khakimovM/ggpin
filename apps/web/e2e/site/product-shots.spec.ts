import { test } from '@playwright/test';
import { E2E_DEGRADED_SITE_URL, E2E_SPARSE_SITE_URL } from '../support/app-env';
import { saveShot } from '../store/shot-file';
import { openProduct, PRODUCTS, type ProductLang } from './product-support';

// Screenshots of the product pages (phase 8 S3, QA material to set beside Site.dc.html `page:
// product`): one file per page, state, width, theme and language, written into $SHOTS_DIR. Without
// the variable the file registers no tests, so the normal run is unaffected.
//
//   SHOTS_DIR=... npx playwright test e2e/site/product-shots.spec.ts --project=w1440

const DIR = process.env.SHOTS_DIR;

if (DIR !== undefined && DIR !== '') {
  for (const lang of ['uz', 'ru'] as const satisfies ProductLang[]) {
    for (const scheme of ['light', 'dark'] as const) {
      test.describe(`${lang} / ${scheme}`, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
        });

        for (const { slug, key } of PRODUCTS) {
          test(`${key}: the whole page`, async ({ page }) => {
            await openProduct(page, slug, lang);
            await saveShot(page, DIR, `product-${key}-${lang}-${scheme}`);
          });

          test(`${key}: the first screen`, async ({ page }) => {
            await openProduct(page, slug, lang);
            await saveShot(page, DIR, `product-${key}-hero-${lang}-${scheme}`, {
              fullPage: false,
            });
          });
        }
      });

      test.describe(`${lang} / ${scheme} / API down`, () => {
        test.use({ baseURL: E2E_DEGRADED_SITE_URL });
        test('Stars without prices', async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await openProduct(page, 'telegram-stars', lang);
          await saveShot(page, DIR, `product-stars-down-${lang}-${scheme}`, { fullPage: false });
        });
      });

      test.describe(`${lang} / ${scheme} / thin catalog`, () => {
        test.use({ baseURL: E2E_SPARSE_SITE_URL });
        test('Stars with no packages', async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await openProduct(page, 'telegram-stars', lang);
          await saveShot(page, DIR, `product-stars-nopackages-${lang}-${scheme}`, {
            fullPage: false,
          });
        });
        test('Premium not available', async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await openProduct(page, 'telegram-premium', lang);
          await saveShot(page, DIR, `product-premium-gone-${lang}-${scheme}`, {
            fullPage: false,
          });
        });
      });
    }
  }
}
