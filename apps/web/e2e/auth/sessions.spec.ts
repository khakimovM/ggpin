import AxeBuilder from '@axe-core/playwright';
import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test, type Page } from '@playwright/test';
import { watchPage } from '../support/gallery';
import { installFakeApi } from '../support/fake-api';

// Signed-in sessions: the list of devices, ending another one, signing out (also when the
// request does not get through) and what a second tab does about it. API faked with `page.route`.

async function openProfile(page: Page, path = '/store/profile', theme: 'light' | 'dark' = 'light') {
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), theme);
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
}

test.describe('sessions list', () => {
  test('uz: devices, the current one marked, no end button on it', async ({ page }) => {
    const problems = watchPage(page);
    await installFakeApi(page, { signedIn: true });
    await openProfile(page);

    await expect(
      page.getByRole('heading', { level: 2, name: uz.web.sessions.title }),
    ).toBeVisible();
    const rows = page.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Chrome · Windows');
    await expect(rows.nth(0)).toContainText(uz.web.sessions.current);
    await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
    await expect(rows.nth(1)).toContainText('Safari · iOS');
    await expect(rows.nth(2)).toContainText('Safari · macOS');
    await expect(page.getByRole('button', { name: /sessiyasini yakunlash/ })).toHaveCount(2);
    expect(problems).toEqual([]);
  });

  test('ru, dark: the same list, no sideways overflow, accessibility scan clean', async ({
    page,
  }) => {
    await installFakeApi(page, { signedIn: true });
    await openProfile(page, '/ru/store/profile', 'dark');
    await expect(
      page.getByRole('heading', { level: 2, name: ru.web.sessions.title }),
    ).toBeVisible();
    await expect(page.getByText(ru.web.sessions.current)).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(scan.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
  });

  test('ending another device removes it from the list', async ({ page }) => {
    const api = await installFakeApi(page, { signedIn: true });
    await openProfile(page);
    await expect(page.getByRole('listitem')).toHaveCount(3);

    await page.getByRole('button', { name: /Safari · iOS/ }).click();

    await expect(page.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('Safari · iOS')).toHaveCount(0);
    expect(api.count('DELETE /auth/sessions/:id')).toBe(1);
    expect(api.sessions.map((session) => session.id)).toEqual(['sess-current', 'sess-mac']);
  });

  test('"Boshqa barcha sessiyalarni yakunlash" ends every other device and then disappears', async ({
    page,
  }) => {
    const api = await installFakeApi(page, { signedIn: true });
    await openProfile(page);
    await expect(page.getByRole('listitem')).toHaveCount(3);

    await page.getByRole('button', { name: uz.web.sessions.endAll }).click();

    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('button', { name: uz.web.sessions.endAll })).toHaveCount(0);
    expect(api.count('DELETE /auth/sessions/:id')).toBe(2);
    expect(api.sessions.map((session) => session.id)).toEqual(['sess-current']);
  });

  test('one failure stops the rest: error with a retry, the list shows what is left', async ({
    page,
  }) => {
    const api = await installFakeApi(page, { signedIn: true });
    api.revokeFails.add('sess-mac'); // the second device in the list
    await openProfile(page);

    await page.getByRole('button', { name: uz.web.sessions.endAll }).click();

    await expect(page.getByText(uz.web.sessions.endAllError)).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(2); // the iPhone is gone, the Mac stays
    expect(api.count('DELETE /auth/sessions/:id')).toBe(2);

    api.revokeFails.clear();
    await page.getByRole('button', { name: uz.common.retry }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText(uz.web.sessions.endAllError)).toHaveCount(0);
    expect(api.count('DELETE /auth/sessions/:id')).toBe(3);
  });

  test('ru: the end-all button fits and is labelled in Russian', async ({ page }) => {
    await installFakeApi(page, { signedIn: true });
    await openProfile(page, '/ru/store/profile');
    await expect(page.getByRole('button', { name: ru.web.sessions.endAll })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('keyboard only: the end button is reachable and Enter ends the session', async ({
    page,
  }) => {
    const api = await installFakeApi(page, { signedIn: true });
    await openProfile(page);
    const end = page.getByRole('button', { name: /Safari · iOS/ });
    await end.focus();
    await expect(end).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listitem')).toHaveCount(2);
    expect(api.count('DELETE /auth/sessions/:id')).toBe(1);
  });
});

test.describe('signing out', () => {
  test('success: a full navigation to the home page, and the session is gone', async ({ page }) => {
    const api = await installFakeApi(page, { signedIn: true });
    await openProfile(page);
    await page.getByRole('button', { name: uz.web.logout.action }).click();

    await expect(page).toHaveURL('http://localhost:3100/');
    expect(api.count('POST /auth/logout')).toBe(1);
    expect(api.signedIn).toBe(false);

    // The profile is closed to a visitor without a session: it goes to the login page.
    await page.goto('/store/profile');
    await expect(page).toHaveURL(/\/login\?next=%2Fstore%2Fprofile$/);
  });

  test('ru: success goes to /ru', async ({ page }) => {
    await installFakeApi(page, { signedIn: true });
    await openProfile(page, '/ru/store/profile');
    await page.getByRole('button', { name: ru.web.logout.action }).click();
    await expect(page).toHaveURL('http://localhost:3100/ru');
  });

  test('no answer from the server: "Chiqish amalga oshmadi", not a signed-out screen; retry works', async ({
    page,
  }) => {
    const api = await installFakeApi(page, { signedIn: true });
    api.logoutMode = 'drop';
    await openProfile(page);
    await page.getByRole('button', { name: uz.web.logout.action }).click();

    // 3 attempts with a short backoff, then the failure notice.
    await expect(page.getByText(uz.web.logout.failedTitle)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(uz.web.logout.failedHint)).toBeVisible();
    expect(api.count('POST /auth/logout')).toBe(3);
    await expect(page.getByText(uz.web.auth.ended.title)).toHaveCount(0);
    await expect(page).toHaveURL(/\/store\/profile$/);

    api.logoutMode = 'ok';
    await page.getByRole('button', { name: uz.common.retry }).click();
    await expect(page).toHaveURL('http://localhost:3100/');
    expect(api.signedIn).toBe(false);
  });
});

test.describe('two tabs of one browser', () => {
  test('signing out in one tab ends the other one without a redirect, and offers "Kirish"', async ({
    context,
  }) => {
    const api = await installFakeApi(context, { signedIn: true });
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await openProfile(tabA);
    await openProfile(tabB);
    await expect(tabB.getByRole('listitem')).toHaveCount(3);
    const refreshesBefore = api.count('POST /auth/refresh');

    await tabA.getByRole('button', { name: uz.web.logout.action }).click();
    await expect(tabA).toHaveURL('http://localhost:3100/');

    // B was told through BroadcastChannel('ggpin-auth'): no refresh attempt, no redirect.
    await expect(tabB.getByText(uz.web.auth.ended.title)).toBeVisible();
    await expect(tabB.getByRole('link', { name: uz.web.auth.signIn })).toHaveAttribute(
      'href',
      '/login?next=%2Fstore%2Fprofile',
    );
    await expect(tabB).toHaveURL(/\/store\/profile$/);
    expect(api.count('POST /auth/refresh')).toBe(refreshesBefore);
  });
});
