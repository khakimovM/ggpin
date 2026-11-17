import { expect, test, type Page } from '@playwright/test';
import { seedMock } from './support/mock';

/** Presses Tab until the focused element is named `name` (aria-label or its text). */
async function tabTo(page: Page, name: string, max = 40): Promise<void> {
  for (let step = 0; step < max; step += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return '';
      return element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
    });
    if (label === name) return;
  }
  throw new Error(`"${name}" was not reached with Tab`);
}

test('login with the keyboard only', async ({ page }) => {
  await seedMock(page, { pendingPolls: 0 });
  await page.goto('/login');
  await tabTo(page, 'Telegram orqali kirish');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Kod, 1-raqam' })).toBeFocused();
  await page.keyboard.type('123456');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('the shell with the keyboard only: skip link, menu, theme, sign-out', async ({ page }) => {
  await seedMock(page, { signedIn: true });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Asosiy qismga o‘tish' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();

  await tabTo(page, 'To‘lovlar');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/payments$/);

  await tabTo(page, 'Qorong‘i mavzuga o‘tish');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await tabTo(page, 'Chiqish');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/login$/);
});
