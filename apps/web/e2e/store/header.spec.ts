import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test, type Page } from '@playwright/test';
import { installCatalogApi } from '../fixtures/catalog';
import { installFakeApi } from '../support/fake-api';
import { axeViolations } from '../tg/support';

// The store header (phase 7 S5): language, theme and the account menu. Below 1024 px the
// language and theme controls live inside the account menu, from 1024 px they are in the header.

async function openStore(page: Page, path = '/store', theme: 'light' | 'dark' = 'light') {
  // Only when nothing is stored yet: a reload must see the choice the visitor made, not this seed.
  await page.addInitScript((seed) => {
    if (window.localStorage.getItem('ggpin-theme') === null) {
      window.localStorage.setItem('ggpin-theme', seed);
    }
  }, theme);
  await installFakeApi(page, { signedIn: true });
  await installCatalogApi(page);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('list').getByRole('listitem').first()).toBeVisible();
}

const narrow = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;
const menuButton = (page: Page, t: typeof uz) => page.getByRole('button', { name: t.web.nav.menu });

/** Opens the account menu when the control being looked for is inside it (narrow screens). */
async function reveal(page: Page, t: typeof uz) {
  if (narrow(page)) await menuButton(page, t).click();
}

test.describe('language', () => {
  test('the switch reloads the same page in the other language, query kept', async ({ page }) => {
    await openStore(page, '/store?category=games');
    await reveal(page, uz);
    await page.getByRole('radio', { name: uz.web.nav.langRu }).click();
    await expect(page).toHaveURL(/\/ru\/store\?category=games$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Игры' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

    await reveal(page, ru);
    await page.getByRole('radio', { name: ru.web.nav.langUz }).click();
    await expect(page).toHaveURL(/\/store\?category=games$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'uz');
  });
});

test.describe('theme', () => {
  test('the toggle switches light and dark and remembers the choice', async ({ page }) => {
    await openStore(page, '/store', 'light');
    await reveal(page, uz);
    await page.getByRole('button', { name: uz.web.nav.theme }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => window.localStorage.getItem('ggpin-theme'))).toBe('dark');
    expect(await axeViolations(page)).toEqual([]);

    // A reload keeps it, with no light flash (the pre-paint script reads the same key).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('account menu', () => {
  test('opens, shows the profile and the sign-out, closes with Escape and gives the focus back', async ({
    page,
  }) => {
    await openStore(page);
    const button = menuButton(page, uz);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('#account-menu');
    await expect(panel.getByText('@sardor_r')).toBeVisible();
    await expect(panel.getByRole('link', { name: uz.web.nav.profile })).toHaveAttribute(
      'href',
      '/store/profile',
    );
    await expect(panel.getByRole('button', { name: uz.web.logout.action })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('a click outside closes it; the profile link goes to the profile', async ({ page }) => {
    await openStore(page);
    await menuButton(page, uz).click();
    await page.getByRole('heading', { level: 1 }).click();
    await expect(page.locator('#account-menu')).toHaveCount(0);

    await menuButton(page, uz).click();
    await page.locator('#account-menu').getByRole('link', { name: uz.web.nav.profile }).click();
    await expect(page).toHaveURL(/\/store\/profile$/);
    await expect(
      page.getByRole('heading', { level: 1, name: uz.account.profile.title }),
    ).toBeVisible();
    await expect(page.locator('#account-menu')).toHaveCount(0);
  });

  test('keyboard only: Tab reaches the button, Enter opens it, Tab walks its items', async ({
    page,
  }) => {
    await openStore(page);
    await menuButton(page, uz).focus();
    await page.keyboard.press('Enter');
    // The panel walks: history, profile, ...
    await page.keyboard.press('Tab');
    await expect(
      page.locator('#account-menu').getByRole('link', { name: uz.web.nav.orders }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.locator('#account-menu').getByRole('link', { name: uz.web.nav.profile }),
    ).toBeFocused();
  });
});
