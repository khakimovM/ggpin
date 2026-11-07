import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import { axeViolations, overflow } from '../tg/support';
import { SCHEMES, TEXT, card, openStore, prefix, searchbox, shot, wide } from './catalog-support';

// The web catalog (phase 7 S5): the store header, the categories (a column from 1024 px, chips
// below), the product grid and the search in the URL. The states (skeleton, errors, empty) are in
// catalog-states.spec.ts. API faked with `page.route`; the session is a fake signed-in one.

test.describe('ready', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: header, heading with count, every product once`, async ({
        page,
      }, testInfo) => {
        const t = TEXT[lang];
        await openStore(page, { lang, scheme });

        await expect(
          page.getByRole('heading', { level: 1, name: t.store.catalog.title }),
        ).toBeVisible();
        await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(7);
        await expect(
          page.getByText(lang === 'uz' ? '7 ta mahsulot' : '7 товаров').first(),
        ).toBeVisible();

        const nav = page.getByRole('navigation', { name: t.web.nav.main });
        if (wide(page)) {
          await expect(nav.getByRole('link', { name: t.web.nav.catalog })).toHaveAttribute(
            'aria-current',
            'page',
          );
        }
        await expect(page.getByTestId('header-balance')).toContainText(/85.400/);
        await expect(page.getByRole('button', { name: t.web.nav.topUp })).toHaveAttribute(
          'aria-disabled',
          'true',
        );

        // Links go to the product screen of the same language (S6).
        await expect(card(page, 'PUBG Mobile')).toHaveAttribute(
          'href',
          `${prefix(lang)}/store/products/pubg-mobile`,
        );
        await expect(card(page, 'Telegram Stars')).toContainText(
          lang === 'uz' ? /5.500.*dan/ : /от.*5.500/,
        );
        await expect(card(page, 'Free Fire')).toContainText(t.store.catalog.soldOut);
        await expect(card(page, 'Free Fire')).not.toContainText(/so‘m|сум/);

        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `catalog-${lang}-${scheme}`);
      });
    }
  }

  test('categories: a column from 1024 px, chips with counts below it', async ({ page }) => {
    await openStore(page);
    await expect(card(page, 'Steam')).toBeVisible();
    const sidebar = page.getByRole('complementary', { name: uz.store.catalog.categories.label });
    const chips = page.getByRole('group', { name: uz.store.catalog.categories.label });
    if (wide(page)) {
      await expect(sidebar).toBeVisible();
      await expect(chips).toBeHidden();
      await expect(sidebar.getByRole('button', { name: /O‘yinlar/ })).toContainText('3');
    } else {
      await expect(sidebar).toBeHidden();
      await expect(chips.getByRole('button', { name: /O‘yinlar · 3/ })).toBeVisible();
    }
  });

  test('a category lives in the URL: link in, click, and an invalid one is ignored', async ({
    page,
  }) => {
    const api = await openStore(page, { path: '/store?category=games' });
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    await expect(card(page, 'Steam')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'O‘yinlar' })).toBeVisible();
    expect(api.productRequests().some((u) => u.searchParams.get('category') === 'games')).toBe(
      true,
    );

    const pick = (name: RegExp) =>
      (wide(page)
        ? page.getByRole('complementary').getByRole('button', { name })
        : page
            .getByRole('group', { name: uz.store.catalog.categories.label })
            .getByRole('button', { name })
      ).click();
    await pick(/Platformalar/);
    await expect(page).toHaveURL(/category=platforms/);
    await expect(card(page, 'Steam')).toBeVisible();
    await expect(card(page, 'PUBG Mobile')).toHaveCount(0);
    await pick(/Hammasi/);
    await expect(page).not.toHaveURL(/category=/);

    await page.goto('/store?category=Not%20A%20Slug%3B');
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    await expect(card(page, 'Steam')).toBeVisible();
  });
});

test.describe('search in the URL', () => {
  test('typing is debounced into ?q=, survives a reload, and clearing removes it', async ({
    page,
  }) => {
    const api = await openStore(page);
    await expect(card(page, 'Steam')).toBeVisible();
    await searchbox(page).pressSequentially('pubg', { delay: 40 });
    await expect(page).toHaveURL(/[?&]q=pubg$/);
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    await expect(card(page, 'Steam')).toHaveCount(0);
    expect(
      api
        .productRequests()
        .filter((u) => u.searchParams.has('q'))
        .map((u) => u.searchParams.get('q')),
    ).toEqual(['pubg']);

    await page.reload();
    await expect(searchbox(page)).toHaveValue('pubg');
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    await expect(card(page, 'Steam')).toHaveCount(0);

    await page.getByRole('button', { name: uz.store.catalog.search.clear }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(card(page, 'Steam')).toBeVisible();
  });

  test('a link with ?q= opens the search already filled, in Russian too', async ({ page }) => {
    await openStore(page, { lang: 'ru', path: '/store?q=steam' });
    await expect(searchbox(page)).toHaveValue('steam');
    await expect(card(page, 'Steam')).toBeVisible();
    await expect(card(page, 'PUBG Mobile')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { level: 1, name: ru.store.catalog.results }),
    ).toBeVisible();
  });

  test('searching from the profile page takes the visitor to the catalog with the result', async ({
    page,
  }) => {
    await openStore(page, { path: '/store/profile' });
    await expect(page.getByRole('heading', { level: 1, name: uz.web.profile.title })).toBeVisible();
    await searchbox(page).fill('steam');
    await expect(page).toHaveURL(/\/store\?q=steam$/);
    await expect(card(page, 'Steam')).toBeVisible();
  });

  test('leaving the catalog with a search active does not bounce the visitor back, and back works', async ({
    page,
  }) => {
    await openStore(page, { path: '/store?q=steam' });
    await expect(card(page, 'Steam')).toBeVisible();
    await page.getByRole('button', { name: uz.web.nav.menu }).click();
    await page.locator('#account-menu').getByRole('link', { name: uz.web.nav.profile }).click();
    await expect(page).toHaveURL(/\/store\/profile$/);
    await expect(page.getByRole('heading', { level: 1, name: uz.web.profile.title })).toBeVisible();
    // Long enough for the debounce and any wrong redirect to have happened.
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/store\/profile$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/store\?q=steam$/);
    await expect(card(page, 'Steam')).toBeVisible();
    await page.goBack();
    // Not trapped: back goes on to the page before the catalog (the blank start page).
    await expect(page).not.toHaveURL(/\/store/);
  });

  test('no match: the text is quoted, and "Qidiruvni tozalash" clears it', async ({
    page,
  }, testInfo) => {
    await openStore(page, { path: '/store?q=zzzz' });
    await expect(page.getByText(uz.store.catalog.noResults.title)).toBeVisible();
    await expect(page.getByText(/zzzz/).first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, 'catalog-no-results');
    await page.getByRole('button', { name: uz.store.catalog.noResults.cta }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(card(page, 'Steam')).toBeVisible();
  });
});
