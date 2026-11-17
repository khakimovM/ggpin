import { expect, test } from '@playwright/test';
import { seedMock } from './support/mock';

test.describe('admin login (Login.dc.html variant admin)', () => {
  test('start, waiting, code, wrong code, then the panel', async ({ page }) => {
    await seedMock(page, { pendingPolls: 1 });
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Admin panel' })).toBeVisible();
    await expect(page.getByRole('note')).toHaveText('Faqat ruxsat berilgan xodimlar kira oladi');
    await expect(page.getByText('STAGING')).toBeVisible();

    await page.getByRole('button', { name: 'Telegram orqali kirish' }).click();
    const botLink = page.getByRole('link', { name: 'Telegramʼni ochish' });
    await expect(botLink).toHaveAttribute(
      'href',
      /^https:\/\/t\.me\/ggpin_mock_bot\?start=admin_[\w-]{43}$/,
    );
    await expect(page.getByRole('status')).toHaveText('Telegramʼdan javob kutilmoqda…');

    await expect(page.getByText('Kod Telegramʼga yuborildi')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('@ggpin_mock_bot yuborgan 6 xonali kod')).toBeVisible();
    await page.keyboard.type('000000');
    await expect(page.getByText('Kod noto‘g‘ri. Yana 4 ta urinish qoldi')).toBeVisible();

    await page.keyboard.press('Backspace');
    for (let index = 0; index < 6; index += 1) await page.keyboard.press('Backspace');
    await page.getByRole('textbox', { name: 'Kod, 1-raqam' }).focus();
    await page.keyboard.type('123456');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('a refusal in the bot shows the rejected state and can start again', async ({ page }) => {
    await seedMock(page, { deny: true, pendingPolls: 0 });
    await page.goto('/login');
    await page.getByRole('button', { name: 'Telegram orqali kirish' }).click();
    await expect(page.getByText('So‘rov Telegramʼda rad etildi.')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Qaytadan boshlash' }).click();
    await expect(page.getByRole('link', { name: 'Telegramʼni ochish' })).toBeVisible();
  });

  test('a failing start shows the service error banner', async ({ page }) => {
    await seedMock(page, { startFails: true });
    await page.goto('/login');
    await page.getByRole('button', { name: 'Telegram orqali kirish' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Telegram orqali kirish vaqtincha ishlamayapti',
    );
    await expect(page.getByRole('button', { name: 'Telegram orqali kirish' })).toBeEnabled();
  });

  test('SUPPORT lands on the orders, not the dashboard it may not read', async ({ page }) => {
    await seedMock(page, { role: 'SUPPORT', pendingPolls: 0 });
    await page.goto('/login');
    await page.getByRole('button', { name: 'Telegram orqali kirish' }).click();
    await page.getByRole('textbox', { name: 'Kod, 1-raqam' }).focus();
    await page.keyboard.type('123456');
    await expect(page).toHaveURL(/\/orders$/);
  });

  test('a signed-out deep link returns there after login', async ({ page }) => {
    await seedMock(page, { pendingPolls: 0 });
    await page.goto('/payments');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole('button', { name: 'Telegram orqali kirish' }).click();
    await page.getByRole('textbox', { name: 'Kod, 1-raqam' }).focus();
    await page.keyboard.type('123456');
    await expect(page).toHaveURL(/\/payments$/);
  });

  test('sign-out ends the session: back to login, and the panel stays closed', async ({ page }) => {
    await seedMock(page, { signedIn: true });
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Chiqish' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});
