import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import { installCatalogApi } from '../fixtures/catalog';
import { axeViolations, overflow } from './support';
import { SCHEMES, TEXT, attachShot, card, chip, openHome } from './home-support';

// The Mini App home (phase 7 S5): skeleton, catalog error, offline, empty states, categories and
// search.

test.describe('skeleton', () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: wallet and catalog show their placeholders, then the content`, async ({
      page,
    }, testInfo) => {
      const api = await openHome(page, {
        scheme,
        hold: true,
        catalog: { products: 'slow', categories: 'slow', wallet: 'slow' },
      });
      await expect(page.getByText(uz.store.catalog.loading)).toBeAttached();
      await expect(page.getByText(uz.wallet.card.loading)).toBeAttached();
      await expect(page.locator('[aria-busy="true"]')).not.toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1, name: 'Sardor' })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `home-skeleton-${scheme}`);

      api.release();
      await expect(card(page, 'Telegram Stars')).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    });
  }
});

test.describe('catalog error and offline', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: a catalog that fails shows the error, and retry brings the products`, async ({
      page,
    }, testInfo) => {
      const t = TEXT[lang].store.catalog;
      await openHome(page, { lang, catalog: { products: 'error', categories: 'error' } });
      const alert = page.getByRole('alert').filter({ hasText: t.error.title });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(t.error.body);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `home-error-${lang}`);

      await installCatalogApi(page);
      await alert.getByRole('button', { name: TEXT[lang].common.retry }).click();
      await expect(card(page, 'Telegram Stars')).toBeVisible();
      await expect(alert).toHaveCount(0);
    });

    test(`${lang}: no connection shows the banner next to the error, and retry recovers`, async ({
      page,
    }, testInfo) => {
      const t = TEXT[lang].store.catalog;
      await openHome(page, {
        lang,
        catalog: { products: 'drop', categories: 'drop', wallet: 'drop' },
      });
      const banner = page.getByRole('status').filter({ hasText: t.offline.title });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(t.offline.body);
      await expect(page.getByRole('alert').filter({ hasText: t.error.title })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `home-offline-${lang}`);

      await installCatalogApi(page);
      await banner.getByRole('button', { name: TEXT[lang].common.retry }).click();
      await expect(card(page, 'Telegram Stars')).toBeVisible();
      await expect(banner).toHaveCount(0);
    });
  }

  test('losing the connection after load shows the banner above what is cached, and it leaves again', async ({
    page,
    context,
  }) => {
    await openHome(page);
    await expect(card(page, 'Telegram Stars')).toBeVisible();
    const banner = page.getByRole('status').filter({ hasText: uz.store.catalog.offline.title });
    await expect(banner).toHaveCount(0);

    await context.setOffline(true);
    await expect(banner).toBeVisible();
    // The cached products stay on screen.
    await expect(card(page, 'Telegram Stars')).toBeVisible();

    await context.setOffline(false);
    await expect(banner).toHaveCount(0);
  });
});

test.describe('categories that cannot be loaded', () => {
  test('a small error with a retry; the products still show, then the chips come back', async ({
    page,
  }) => {
    await openHome(page, { catalog: { categories: 'error' } });
    const alert = page.getByRole('alert').filter({ hasText: uz.store.catalog.categories.error });
    await expect(alert).toBeVisible();
    await expect(card(page, 'Telegram Stars')).toBeVisible();
    await expect(chip(page, uz.store.catalog.categories.all)).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);

    await installCatalogApi(page);
    await alert.getByRole('button', { name: uz.common.retry }).click();
    await expect(chip(page, uz.store.catalog.categories.all)).toBeVisible();
    await expect(alert).toHaveCount(0);
  });
});

test.describe('empty states', () => {
  test('an empty catalog says so, with a retry', async ({ page }) => {
    await openHome(page, { catalog: { products: 'empty', categories: 'empty' } });
    await expect(page.getByText(uz.store.catalog.empty.title)).toBeVisible();
    await expect(page.getByText(uz.store.catalog.empty.body)).toBeVisible();
    await expect(page.getByRole('button', { name: uz.common.retry })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('a category with nothing in it offers all products', async ({ page }, testInfo) => {
    await openHome(page, { catalog: { emptyCategories: ['games'] } });
    await chip(page, 'O‘yinlar').click();
    await expect(page.getByText(uz.store.catalog.emptyCategory.title)).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'home-empty-category');
    await page.getByRole('button', { name: uz.store.catalog.emptyCategory.cta }).click();
    await expect(chip(page, uz.store.catalog.categories.all)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(card(page, 'Telegram Stars')).toBeVisible();
  });

  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: a search with no match says so, quotes the text, and clears`, async ({
      page,
    }, testInfo) => {
      const t = TEXT[lang].store.catalog;
      await openHome(page, { lang });
      await page.getByRole('searchbox').fill('zzzzzz');
      await expect(page.getByText(t.noResults.title)).toBeVisible();
      await expect(page.getByText(/zzzzzz/).first()).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `home-no-results-${lang}`);

      await page.getByRole('button', { name: t.noResults.cta }).click();
      await expect(page.getByRole('searchbox')).toHaveValue('');
      await expect(card(page, 'Telegram Stars')).toBeVisible();
    });
  }
});

test.describe('categories and search', () => {
  test('a category chip shows only its products and asks the API for them', async ({ page }) => {
    const api = await openHome(page);
    await expect(card(page, 'Telegram Stars')).toBeVisible();
    await chip(page, 'O‘yinlar').click();
    await expect(chip(page, 'O‘yinlar')).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    await expect(card(page, 'Telegram Stars')).toHaveCount(0);
    await expect(card(page, 'Steam')).toHaveCount(0);
    expect(api.productRequests().some((u) => u.searchParams.get('category') === 'games')).toBe(
      true,
    );

    await chip(page, uz.store.catalog.categories.all).click();
    await expect(card(page, 'Steam')).toBeVisible();
  });

  test('typing waits 300 ms: one request for the whole word, trimmed, with no category', async ({
    page,
  }) => {
    const api = await openHome(page);
    await expect(card(page, 'Telegram Stars')).toBeVisible();
    await chip(page, 'O‘yinlar').click();
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    const before = api.productRequests().length;

    await page.getByRole('searchbox').pressSequentially('  pubg  ', { delay: 40 });
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    await expect(card(page, 'Mobile Legends')).toHaveCount(0);
    await page.waitForTimeout(500);

    const searches = api
      .productRequests()
      .slice(before)
      .filter((u) => u.searchParams.has('q'));
    expect(searches.map((u) => u.searchParams.get('q'))).toEqual(['pubg']);
    // A search covers the whole catalog: the chosen category is not sent with it.
    expect(searches[0]?.searchParams.has('category')).toBe(false);
    await expect(
      page.getByRole('heading', { level: 2, name: uz.store.catalog.results }),
    ).toBeVisible();
  });

  test('the box takes at most 64 characters', async ({ page }) => {
    const api = await openHome(page);
    await page.getByRole('searchbox').fill('a'.repeat(80));
    await expect(page.getByRole('searchbox')).toHaveValue('a'.repeat(64));
    await expect
      .poll(() => api.productRequests().some((u) => u.searchParams.get('q') === 'a'.repeat(64)))
      .toBe(true);
    expect(api.productRequests().every((u) => (u.searchParams.get('q') ?? '').length <= 64)).toBe(
      true,
    );
  });

  test('clearing the box brings the categories back at once', async ({ page }) => {
    await openHome(page);
    const box = page.getByRole('searchbox');
    await box.fill('steam');
    await expect(card(page, 'Steam')).toBeVisible();
    await expect(card(page, 'Telegram Stars')).toHaveCount(0);
    await page.getByRole('button', { name: uz.store.catalog.search.clear }).click();
    await expect(box).toHaveValue('');
    await expect(card(page, 'Telegram Stars')).toBeVisible();
  });
});
