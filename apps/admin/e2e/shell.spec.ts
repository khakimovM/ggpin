import { expect, test } from '@playwright/test';
import { chooseTheme, seedMock, shotPath, type ThemeName } from './support/mock';

const THEMES: ThemeName[] = ['light', 'dark'];

for (const theme of THEMES) {
  test.describe(`shell, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await chooseTheme(page, theme);
    });

    test('the signed-in frame: sidebar, header, page', async ({ page }, testInfo) => {
      await seedMock(page, { signedIn: true, role: 'OWNER' });
      await page.goto('/dashboard');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const nav = page.getByRole('navigation', { name: 'Admin menyu' });
      await expect(nav.getByRole('link')).toHaveCount(13);
      await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
      await expect(page.getByText('STAGING')).toBeVisible();
      await expect(page.getByRole('group', { name: 'Aziz O., OWNER' })).toBeVisible();

      const wide = testInfo.project.name === 'w1440';
      const sidebar = page.locator('aside');
      expect((await sidebar.boundingBox())?.width).toBe(wide ? 248 : 64);
      await expect(nav.getByText('Asosiy')).toBeVisible({ visible: wide });
      await page.screenshot({ path: shotPath(`shell-${testInfo.project.name}-${theme}`) });

      await nav.getByRole('link', { name: 'Buyurtmalar' }).click();
      await expect(page).toHaveURL(/\/orders$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Buyurtmalar' })).toBeVisible();
    });

    test('the login page', async ({ page }, testInfo) => {
      await seedMock(page, {});
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1, name: 'Admin panel' })).toBeVisible();
      await page.screenshot({
        path: shotPath(`login-${testInfo.project.name}-${theme}`),
        fullPage: true,
      });
    });
  });
}

test('a section the role may not read shows the lock state, not an empty page', async ({
  page,
}) => {
  await seedMock(page, { signedIn: true, role: 'SUPPORT' });
  await page.goto('/admins');
  await expect(page.getByRole('heading', { level: 1, name: 'Adminlar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bu bo‘lim faqat OWNER uchun' })).toBeVisible();
  await expect(page.getByText('Sizning rolingiz: SUPPORT')).toBeVisible();
});

test('an unknown address inside the panel is a not-found page', async ({ page }) => {
  await seedMock(page, { signedIn: true });
  await page.goto('/nowhere');
  await expect(page.getByRole('heading', { level: 1, name: 'Sahifa topilmadi' })).toBeAttached();
  await page.getByRole('link', { name: 'Bosh sahifaga' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('the theme switch flips the theme and is remembered', async ({ page }) => {
  await chooseTheme(page, 'light');
  await seedMock(page, { signedIn: true });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Qorong‘i mavzuga o‘tish' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => window.localStorage.getItem('ggpin-theme'))).toBe('dark');
});
