import { test, type Page } from '@playwright/test';
import { openStoreAccount } from '../store/account-support';
import { openStore } from '../store/catalog-support';
import { saveShot } from '../store/shot-file';
import { openAccount } from '../tg/account-support';
import { INFO_PAGES, openInfo, type InfoLang } from './info-support';

// Screenshots of the information pages of phase 8 S4 (QA material; these pages have no design of
// their own, see the S4 report): the FAQ, the contacts and the two legal drafts, and the places
// that link to them (the store footer, the foot of the web and the Mini App profile). One file per
// page, width, theme and language, written into $SHOTS_DIR. In the w375 project every page is also
// taken at 360 px. Without the variable the file registers no tests, so the normal run is unaffected.
//
//   SHOTS_DIR=... npx playwright test e2e/site/info-shots.spec.ts --project=w375 --project=w768 --project=w1440

const DIR = process.env.SHOTS_DIR;

/** The shot at the project's width, and in the 375 px project a second one at 360 px. */
async function shotAndNarrow(page: Page, dir: string, name: string, fullPage = true) {
  await saveShot(page, dir, name, { fullPage });
  if (page.viewportSize()?.width !== 375) return;
  await page.setViewportSize({ width: 360, height: 800 });
  await saveShot(page, dir, name, { fullPage });
}

if (DIR !== undefined && DIR !== '') {
  for (const lang of ['uz', 'ru'] as const satisfies InfoLang[]) {
    for (const scheme of ['light', 'dark'] as const) {
      test.describe(`${lang} / ${scheme}`, () => {
        for (const which of INFO_PAGES) {
          test(`${which}: the whole page`, async ({ page }) => {
            await page.emulateMedia({ colorScheme: scheme });
            await openInfo(page, which, lang);
            await shotAndNarrow(page, DIR, `info-${which}-${lang}-${scheme}`);
          });
        }

        test('the store footer', async ({ page }) => {
          await openStore(page, { lang, scheme });
          const footer = page.getByRole('contentinfo');
          await footer.scrollIntoViewIfNeeded();
          await shotAndNarrow(page, DIR, `info-store-footer-${lang}-${scheme}`, false);
        });

        test('the foot of the web profile', async ({ page }) => {
          await openStoreAccount(page, '/store/profile', { lang, scheme });
          const legal = page.getByRole('main').locator('footer');
          await legal.scrollIntoViewIfNeeded();
          await shotAndNarrow(page, DIR, `info-web-profile-${lang}-${scheme}`, false);
        });

        test('the foot of the Mini App profile', async ({ page }) => {
          await openAccount(page, '/tg/profile', { lang, scheme });
          const legal = page.getByRole('main').locator('footer');
          await legal.scrollIntoViewIfNeeded();
          await shotAndNarrow(page, DIR, `info-tg-profile-${lang}-${scheme}`, false);
        });
      });
    }
  }
}
