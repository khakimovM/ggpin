import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import { saveShot } from '../store/shot-file';
import { settle } from '../support/settle';

// Screenshots of the site shell (phase 8 S1, QA material to set beside Site.dc.html): one file per
// screen, width, theme and language, written into $SHOTS_DIR. Without the variable the file
// registers no tests, so the normal run is unaffected.

const DIR = process.env.SHOTS_DIR;
const LANGS = { uz: { copy: uz.site, prefix: '' }, ru: { copy: ru.site, prefix: '/ru' } } as const;

if (DIR !== undefined && DIR !== '') {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const { copy, prefix } = LANGS[lang];
      test.describe(`${lang} / ${scheme}`, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
        });

        test('header and footer (home)', async ({ page }) => {
          await page.goto(prefix === '' ? '/' : prefix);
          await expect(page.getByRole('contentinfo')).toBeVisible();
          await settle(page);
          await saveShot(page, DIR, `home-${lang}-${scheme}`);
        });

        test('the open menu', async ({ page }) => {
          await page.goto(prefix === '' ? '/' : prefix);
          const button = page.getByRole('button', { name: copy.nav.menu });
          if (!(await button.isVisible())) return;
          await button.click();
          await expect(page.getByRole('link', { name: copy.nav.faq }).first()).toBeVisible();
          await settle(page);
          await saveShot(page, DIR, `menu-${lang}-${scheme}`, { fullPage: false });
        });

        test('the error page', async ({ page }) => {
          await page.goto(`${prefix}/e2e-probe-error`);
          await expect(page.getByRole('heading', { name: copy.error.title })).toBeVisible();
          await settle(page);
          await saveShot(page, DIR, `error-${lang}-${scheme}`);
        });
      });
    }
  }
}
