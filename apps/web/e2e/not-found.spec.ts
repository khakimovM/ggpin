import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import { installFakeWebApp, stubTelegramSdk, tgCallNames } from './fixtures/telegram';
import { installTgApi } from './fixtures/tg-api';
import { axeViolations, INIT_DATA, overflow } from './tg/support';

// 404 pages (phase 7 S4): Next's English default is replaced by the design's 404 in uz and ru, for
// the website (inside the locale layout) and for the Mini App (inside its gate).

const NEXT_DEFAULT = 'This page could not be found';

test.describe('website', () => {
  for (const [path, copy, home] of [
    ['/nonexistent', uz.common.notFound, '/'],
    ['/ru/nonexistent', ru.common.notFound, '/ru'],
    ['/ru/a.b', ru.common.notFound, '/ru'],
    ['/a/b/c', uz.common.notFound, '/'],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${path} (${scheme}): translated 404, a way home, accessible`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        const response = await page.goto(path);
        expect(response?.status()).toBe(404);
        await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
        await expect(page.getByText(copy.body)).toBeVisible();
        await expect(page.getByRole('link', { name: copy.cta })).toHaveAttribute('href', home);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await expect(page.getByText(NEXT_DEFAULT)).toHaveCount(0);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }

  test('the way home works', async ({ page }) => {
    await page.goto('/ru/nonexistent');
    await page.getByRole('link', { name: ru.common.notFound.cta }).click();
    await expect(page).toHaveURL(/\/ru$/);
  });
});

test.describe('Mini App', () => {
  test('a screen that does not exist: translated 404 inside the app, BackButton on, home link', async ({
    page,
  }) => {
    await installFakeWebApp(page, { initData: INIT_DATA, languageCode: 'ru' });
    await installTgApi(page, [{ kind: 'ok', user: { locale: 'ru' } }]);
    // The HTTP status is 200 here, not 404: the gate renders the splash on the server, so the
    // missing screen is found on the client. Harmless for an app shell nobody indexes.
    await page.goto('/tg/nonexistent');
    await expect(page.getByRole('heading', { name: ru.common.notFound.title })).toBeVisible();
    await expect(page.getByText(NEXT_DEFAULT)).toHaveCount(0);
    expect(await tgCallNames(page)).toContain('BackButton.show');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole('link', { name: ru.common.notFound.cta }).click();
    await expect(page).toHaveURL(/\/tg$/);
    await expect(page.getByRole('heading', { name: /Sardor/ })).toBeVisible();
  });

  test('uz, dark', async ({ page }) => {
    await installFakeWebApp(page, { initData: INIT_DATA, colorScheme: 'dark' });
    await installTgApi(page);
    await page.goto('/tg/a.b');
    await expect(page.getByRole('heading', { name: uz.common.notFound.title })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await axeViolations(page)).toEqual([]);
  });

  test('outside Telegram the gate comes first, not the 404', async ({ page }) => {
    await stubTelegramSdk(page);
    await installTgApi(page);
    await page.goto('/tg/nonexistent');
    await expect(page.getByRole('heading', { name: uz.tg.gate.bot.title })).toBeVisible();
    await expect(page.getByRole('heading', { name: uz.common.notFound.title })).toHaveCount(0);
  });
});
