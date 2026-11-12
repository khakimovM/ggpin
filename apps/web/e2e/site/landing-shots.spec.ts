import { test } from '@playwright/test';
import { E2E_DEGRADED_SITE_URL } from '../support/app-env';
import { saveShot } from '../store/shot-file';
import { LANDING, openLanding, type LandingLang } from './landing-support';

// Screenshots of the landing (phase 8 S2, QA material to set beside Site.dc.html): one file per
// state, width, theme and language, written into $SHOTS_DIR. Without the variable the file
// registers no tests, so the normal run is unaffected.
//
//   SHOTS_DIR=... npx playwright test e2e/site/landing-shots.spec.ts --project=w1440

const DIR = process.env.SHOTS_DIR;

if (DIR !== undefined && DIR !== '') {
  for (const lang of ['uz', 'ru'] as const satisfies LandingLang[]) {
    for (const scheme of ['light', 'dark'] as const) {
      test.describe(`${lang} / ${scheme}`, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
        });

        test('the whole page', async ({ page }) => {
          await openLanding(page, lang);
          await saveShot(page, DIR, `landing-${lang}-${scheme}`);
        });

        test('the first screen', async ({ page }) => {
          await openLanding(page, lang);
          await saveShot(page, DIR, `landing-hero-${lang}-${scheme}`, { fullPage: false });
        });

        test('the FAQ section', async ({ page }) => {
          await openLanding(page, lang);
          await page.locator('#faq').scrollIntoViewIfNeeded();
          await saveShot(page, DIR, `landing-faq-${lang}-${scheme}`, { fullPage: false });
        });
      });

      test.describe(`${lang} / ${scheme} / API down`, () => {
        test.use({ baseURL: E2E_DEGRADED_SITE_URL });

        test('the products without prices', async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(LANDING[lang].path);
          // The skeleton's list is swapped for the real one when the (failed) catalog answers.
          const list = page.locator('#products ul[data-state="unavailable"]');
          await list.waitFor();
          await list.scrollIntoViewIfNeeded();
          await saveShot(page, DIR, `landing-products-down-${lang}-${scheme}`, {
            fullPage: false,
          });
        });
      });
    }
  }
}
