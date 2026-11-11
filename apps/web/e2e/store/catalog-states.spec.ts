import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import { installCatalogApi } from '../fixtures/catalog';
import { axeViolations, overflow } from '../tg/support';
import { SCHEMES, TEXT, card, openStore, shot } from './catalog-support';

// The web catalog (phase 7 S5), its states: skeleton, catalog and categories errors, offline,
// empty. API faked with `page.route`; the session is a fake signed-in one.

test.describe('states', () => {
  for (const scheme of SCHEMES) {
    test(`${scheme} skeleton: placeholders in the grid and the pill, then the products`, async ({
      page,
    }, testInfo) => {
      const api = await openStore(page, {
        scheme,
        hold: true,
        catalog: { products: 'slow', categories: 'slow', wallet: 'slow' },
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(uz.store.catalog.loading)).toBeAttached();
      await expect(page.locator('[aria-busy="true"]')).not.toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `catalog-skeleton-${scheme}`);
      api.release();
      await expect(card(page, 'Steam')).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    });
  }

  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: a failing catalog shows the error and retry recovers it`, async ({
      page,
    }, testInfo) => {
      const t = TEXT[lang].store.catalog;
      await openStore(page, {
        lang,
        catalog: { products: 'error', categories: 'error', wallet: 'error' },
      });
      const alert = page.getByRole('alert').filter({ hasText: t.error.title });
      await expect(alert).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `catalog-error-${lang}`);
      await installCatalogApi(page);
      await alert.getByRole('button', { name: TEXT[lang].common.retry }).click();
      await expect(card(page, 'Steam')).toBeVisible();
    });

    test(`${lang}: no connection shows the banner, retry recovers`, async ({ page }, testInfo) => {
      const t = TEXT[lang].store.catalog;
      await openStore(page, {
        lang,
        catalog: { products: 'drop', categories: 'drop', wallet: 'drop' },
      });
      const banner = page.getByRole('status').filter({ hasText: t.offline.title });
      await expect(banner).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `catalog-offline-${lang}`);
      await installCatalogApi(page);
      await banner.getByRole('button', { name: TEXT[lang].common.retry }).click();
      await expect(card(page, 'Steam')).toBeVisible();
      await expect(banner).toHaveCount(0);
    });
  }

  test('a failing new category shows the error, not the previous category products', async ({
    page,
  }) => {
    await openStore(page, { path: '/store?category=telegram' });
    await expect(card(page, 'Telegram Stars')).toBeVisible();
    await installCatalogApi(page, { failCategories: ['games'] });
    await page.goto('/store?category=games');
    await expect(
      page.getByRole('alert').filter({ hasText: uz.store.catalog.error.title }),
    ).toBeVisible();
    await expect(card(page, 'Telegram Stars')).toHaveCount(0);
    await expect(card(page, 'PUBG Mobile')).toHaveCount(0);
  });

  test('empty catalog, and a category that emptied meanwhile', async ({ page }) => {
    await openStore(page, { catalog: { products: 'empty', categories: 'empty' } });
    await expect(page.getByText(uz.store.catalog.empty.title)).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    const fresh = await page.context().newPage();
    await openStore(fresh, {
      path: '/store?category=games',
      catalog: { emptyCategories: ['games'] },
    });
    await expect(fresh.getByText(uz.store.catalog.emptyCategory.title)).toBeVisible();
    await fresh.getByRole('button', { name: uz.store.catalog.emptyCategory.cta }).click();
    await expect(fresh).not.toHaveURL(/category=/);
    await expect(card(fresh, 'Steam')).toBeVisible();
  });
});
