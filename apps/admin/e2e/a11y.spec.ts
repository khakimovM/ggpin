import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { chooseTheme, seedMock, type ThemeName } from './support/mock';

async function seriousViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(' | ')}`,
    );
}

for (const theme of ['light', 'dark'] as ThemeName[]) {
  test.describe(`axe, ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await chooseTheme(page, theme);
    });

    test('login: start and code steps', async ({ page }) => {
      await seedMock(page, { pendingPolls: 0 });
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.getByRole('button', { name: 'Telegram orqali kirish' }).click();
      await expect(page.getByText('Kod Telegramʼga yuborildi')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });

    test('shell and the lock state', async ({ page }) => {
      await seedMock(page, { signedIn: true, role: 'OPERATOR' });
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.goto('/admins');
      await expect(page.getByText('Sizning rolingiz: OPERATOR')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}
