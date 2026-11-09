import { expect, test, type Page } from '@playwright/test';
import { TG_TOKEN } from '../fixtures/tg-api';
import { account, attachShot, openAccount } from './account-support';
import { axeViolations, overflow } from './support';

// The Mini App profile (phase 7 S9): identity and wallet from the server, the language through
// PATCH /me, the reduced-motion switch.

// Next's route announcer is a role=alert of its own: the screen's alerts are the ones in <main>.
const alertOf = (page: Page) => page.getByRole('main').getByRole('alert');

test.describe('profile', () => {
  test('identity, balance and coins from the server, no phone line (uz / light)', async ({
    page,
  }, testInfo) => {
    await openAccount(page, '/tg/profile');
    const t = account('uz').profile;
    await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    await expect(page.getByText('@sardor_r')).toBeVisible();
    await expect(page.getByRole('button', { name: t.idCopy })).toBeVisible();
    await expect(page.getByText(t.balance, { exact: true })).toBeVisible();
    await expect(page.getByText(t.cashback, { exact: true })).toBeVisible();
    await expect(page.getByText(t.phone.title)).toHaveCount(0);
    const services = page.getByRole('region', { name: t.services.title });
    await expect(services.getByText(t.services.soon)).toHaveCount(2);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'profile-uz-light');
  });

  test('language: PATCH /me first, then the screens turn Russian and back', async ({ page }) => {
    const api = await openAccount(page, '/tg/profile');
    await page.getByRole('radio', { name: 'Русский' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: account('ru').profile.title }),
    ).toBeVisible();
    expect(api.patches).toEqual([{ locale: 'ru' }]);
    // The server kept it: the next read of the profile says Russian.
    const me = await page.evaluate(async (token) => {
      const response = await fetch('http://localhost:5000/api/v1/me', {
        headers: { authorization: `Bearer ${token}` },
      });
      return (await response.json()) as { data: { locale: string } };
    }, TG_TOKEN);
    expect(me.data.locale).toBe('ru');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByRole('radio', { name: 'Русский' })).toBeChecked();
    await page.getByRole('radio', { name: 'O‘zbekcha' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: account('uz').profile.title }),
    ).toBeVisible();
    expect(api.patches).toEqual([{ locale: 'ru' }, { locale: 'uz' }]);
  });

  test('language: a refused PATCH keeps the language and says so', async ({ page }) => {
    await openAccount(page, '/tg/profile', { api: { patchFails: true } });
    await page.getByRole('radio', { name: 'Русский' }).click();
    await expect(alertOf(page)).toContainText(account('uz').profile.language.error);
    await expect(
      page.getByRole('heading', { level: 1, name: account('uz').profile.title }),
    ).toBeVisible();
  });

  test('reduced motion: the switch sets data-reduced, and it is still on after a reload', async ({
    page,
  }) => {
    await openAccount(page, '/tg/profile');
    const label = account('uz').profile.settings.reducedMotion.label;
    await page.getByRole('switch', { name: label }).click();
    await expect(page.locator('html')).toHaveAttribute('data-reduced', 'true');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-reduced', 'true');
    await expect(page.getByRole('switch', { name: label })).toBeChecked();
    // A UI setting, never a token: the only key is the flag.
    const keys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(keys.filter((key) => key.includes('reduced'))).toEqual(['ggpin-reduced-motion']);
  });

  test('the Telegram ID is copied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openAccount(page, '/tg/profile');
    const t = account('uz').profile;
    await page.getByRole('button', { name: t.idCopy }).click();
    await expect(page.getByRole('status').filter({ hasText: t.idCopied })).toBeAttached();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\d+$/);
  });
});
