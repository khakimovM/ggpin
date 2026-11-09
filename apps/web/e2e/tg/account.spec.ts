import { expect, test, type Page } from '@playwright/test';
import { tgCallNames } from '../fixtures/telegram';
import { account, attachShot, openAccount } from './account-support';
import { axeViolations, overflow } from './support';

// The Mini App history (phase 7 S9): the four states of both tabs, the filter chips, the pages and
// the tab bar. The profile, referral and help screens are in the account-*.spec.ts files.

const rowsOf = (page: Page) => page.getByRole('tabpanel').getByRole('link');
// Next's route announcer is a role=alert of its own: the screen's alerts are the ones in <main>.
const alertOf = (page: Page) => page.getByRole('main').getByRole('alert');

test.describe('history: orders', () => {
  test('success: grouped rows with status, amount and a link to the order (uz / light)', async ({
    page,
  }, testInfo) => {
    await openAccount(page, '/tg/history');
    const t = account('uz').history;
    await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    await expect(rowsOf(page).first()).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(20);
    await expect(page.getByRole('heading', { level: 2, name: 'Bugun' })).toBeVisible();
    const first = rowsOf(page).first();
    await expect(first).toHaveAttribute('href', '/tg/orders/order_1');
    await expect(first).toContainText('@dilnoza_k · #10500');
    await expect(first).toContainText('Bajarilmoqda');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'history-ready-uz');
  });

  test('skeleton while the first page loads, then the rows', async ({ page }, testInfo) => {
    const api = await openAccount(page, '/tg/history', { api: { orders: 'slow' } });
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(account('uz').history.loading);
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'history-skeleton-uz');
    api.release();
    await expect(rowsOf(page).first()).toBeVisible();
  });

  test('error with "Qayta urinish", then the rows', async ({ page }, testInfo) => {
    const api = await openAccount(page, '/tg/history', { api: { orders: 'error' } });
    const t = account('uz').history;
    await expect(alertOf(page)).toContainText(t.error.title);
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'history-error-uz');
    api.setOrders('ok');
    await page.getByRole('button', { name: 'Qayta urinish' }).click();
    await expect(rowsOf(page).first()).toBeVisible();
  });

  test('empty: the text and "Xaridni boshlash" to the shop', async ({ page }, testInfo) => {
    await openAccount(page, '/tg/history', { api: { orders: 'empty' } });
    const t = account('uz').history.empty.orders;
    await expect(page.getByText(t.title)).toBeVisible();
    await expect(page.getByRole('link', { name: t.cta })).toHaveAttribute('href', '/tg');
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'history-empty-uz');
  });

  test('a filter chip asks for its group of statuses in one request', async ({ page }) => {
    const api = await openAccount(page, '/tg/history');
    const t = account('uz').history;
    await expect(rowsOf(page).first()).toBeVisible();
    await page.getByRole('button', { name: t.filter.done }).click();
    await expect.poll(() => api.orderRequests.at(-1)?.searchParams.get('status')).toBe('DELIVERED');
    await expect(rowsOf(page).first()).toContainText('Yetkazildi');
    await page.getByRole('button', { name: t.filter.wait }).click();
    await expect
      .poll(() => api.orderRequests.at(-1)?.searchParams.get('status'))
      .toBe('PAID,QUEUED,PROCESSING,HELD,NEEDS_REVIEW');
    await page.getByRole('button', { name: t.filter.cancel }).click();
    await expect
      .poll(() => api.orderRequests.at(-1)?.searchParams.get('status'))
      .toBe('FAILED,CANCELLED,REFUNDED');
    await expect(page.getByRole('button', { name: t.filter.cancel })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('20 at a time: "Yana yuklash" appends the second page', async ({ page }) => {
    // The button is the way for a keyboard and a webview that cannot tell what is on screen.
    await page.addInitScript(() => Reflect.deleteProperty(window, 'IntersectionObserver'));
    const api = await openAccount(page, '/tg/history');
    const t = account('uz').history;
    await expect(rowsOf(page)).toHaveCount(20);
    await page.getByRole('button', { name: t.loadMore }).click();
    await expect(rowsOf(page)).toHaveCount(25);
    expect(api.orderRequests.map((u) => u.searchParams.get('page'))).toEqual(['1', '2']);
    expect(api.orderRequests.every((u) => u.searchParams.get('limit') === '20')).toBe(true);
    await expect(page.getByRole('button', { name: t.loadMore })).toBeHidden();
  });

  test('scrolling to the end asks for the next page by itself, and only one', async ({ page }) => {
    // 60 orders: three pages. Over-fetching (page 3 asked for without scrolling again) would show.
    const api = await openAccount(page, '/tg/history', { api: { orderCount: 60 } });
    await expect(rowsOf(page)).toHaveCount(20);
    await page
      .getByRole('button', { name: account('uz').history.loadMore })
      .scrollIntoViewIfNeeded();
    await expect(rowsOf(page)).toHaveCount(40);
    // A stray second request would be on the wire by the time the network is quiet.
    await page.waitForLoadState('networkidle');
    expect(api.orderRequests.map((u) => u.searchParams.get('page'))).toEqual(['1', '2']);
    await expect(rowsOf(page)).toHaveCount(40);
  });

  test('the tab bar: three roots, the current one marked, and no native BackButton on them', async ({
    page,
  }) => {
    await openAccount(page, '/tg/history');
    const t = account('uz').nav;
    const nav = page.getByRole('navigation', { name: t.main });
    await expect(nav.getByRole('link', { name: t.history })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(rowsOf(page).first()).toBeVisible();
    expect(await tgCallNames(page)).not.toContain('BackButton.show');
    await nav.getByRole('link', { name: t.profile }).click();
    await expect(page).toHaveURL(/\/tg\/profile$/);
    await expect(nav.getByRole('link', { name: t.profile })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await tgCallNames(page)).not.toContain('BackButton.show');
    await nav.getByRole('link', { name: t.home }).click();
    await expect(page).toHaveURL(/\/tg$/);
  });

  test('a row opens the order, and the back button is there', async ({ page }) => {
    await openAccount(page, '/tg/history');
    await rowsOf(page).first().click();
    await expect(page).toHaveURL(/\/tg\/orders\/order_1$/);
    await expect.poll(async () => tgCallNames(page)).toContain('BackButton.show');
  });
});

test.describe('history: finance', () => {
  test('rows by kind: money in green with a plus, a purchase with a minus, an order entry links', async ({
    page,
  }, testInfo) => {
    await openAccount(page, '/tg/history');
    const t = account('uz').history;
    await page.getByRole('tab', { name: t.tabs.finance }).click();
    await expect(page.getByRole('tab', { name: t.tabs.finance })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText(t.ledger.kind.PURCHASE).first()).toBeVisible();
    await expect(
      page
        .getByRole('tabpanel')
        .getByText(/−110.000/)
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole('tabpanel')
        .getByText(/\+50.347/)
        .first(),
    ).toBeVisible();
    await expect(rowsOf(page).first()).toHaveAttribute('href', '/tg/orders/order_1');
    await expect(page.getByText(t.ledger.kind.TOPUP).locator('xpath=ancestor::a')).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'finance-ready-uz');
  });

  test('empty', async ({ page }) => {
    await openAccount(page, '/tg/history', { api: { ledger: 'empty' } });
    const t = account('uz').history;
    await page.getByRole('tab', { name: t.tabs.finance }).click();
    await expect(page.getByText(t.empty.finance.title)).toBeVisible();
  });

  test('error: "Qayta urinish" loads the ledger', async ({ page }) => {
    const api = await openAccount(page, '/tg/history', { api: { ledger: 'error' } });
    const t = account('uz').history;
    await page.getByRole('tab', { name: t.tabs.finance }).click();
    await expect(alertOf(page)).toContainText(t.error.title);
    api.setLedger('ok');
    await page.getByRole('button', { name: 'Qayta urinish' }).click();
    await expect(page.getByText(t.ledger.kind.PURCHASE).first()).toBeVisible();
  });
});
