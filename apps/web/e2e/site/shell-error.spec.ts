import { expect, test } from '@playwright/test';
import { overflow } from '../tg/support';
import { LANGS, seriousViolations } from './shell-support';

// The error page (phase 8 S1): the two e2e-only pages that throw while rendering (the `e2e-probe*`
// folders under app/[locale]) show the design's error view, with or without the site chrome.

test.describe('the error page', () => {
  for (const lang of ['uz', 'ru'] as const) {
    const { copy } = LANGS[lang];
    const prefix = lang === 'ru' ? '/ru' : '';

    test(`${lang}: a marketing page that throws keeps the header and the footer`, async ({
      page,
    }) => {
      await page.goto(`${prefix}/e2e-probe-error`);
      await expect(page.getByRole('heading', { name: copy.error.title })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(copy.error.body)).toBeVisible();
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByRole('contentinfo')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // The button answers, and a page that still throws shows the page again instead of crashing.
      await page.getByRole('button', { name: copy.error.reload }).click();
      await expect(page.getByRole('heading', { name: copy.error.title })).toBeVisible({
        timeout: 15_000,
      });
    });

    test(`${lang}: a page without the site chrome (the store, the sign-in page) shows it full page`, async ({
      page,
    }) => {
      await page.goto(`${prefix}/e2e-probe/error`);
      await expect(page.getByRole('heading', { name: copy.error.title })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('button', { name: copy.error.reload })).toBeVisible();
      await expect(page.getByRole('banner')).toHaveCount(0);
      expect(await seriousViolations(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test('a short page leaves the footer at the bottom edge of the window, not under the content', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/e2e-probe-error');
    await expect(page.getByRole('contentinfo')).toBeVisible({ timeout: 15_000 });
    const { footerBottom, viewport } = await page.evaluate(() => ({
      footerBottom: document.querySelector('footer')?.getBoundingClientRect().bottom ?? 0,
      viewport: window.innerHeight,
    }));
    expect(Math.abs(footerBottom - viewport)).toBeLessThanOrEqual(1);
  });

  test('never prints the error message', async ({ page }) => {
    await page.goto('/e2e-probe-error');
    // Next's route announcer is a second role=alert on the page: pick ours by its text.
    await expect(
      page.getByRole('alert').filter({ hasText: LANGS.uz.copy.error.title }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText('e2e probe');
  });
});
