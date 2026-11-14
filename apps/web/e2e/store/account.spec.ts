import { expect, test, type Page } from '@playwright/test';
import { axeViolations, overflow } from '../tg/support';
import {
  SCHEMES,
  account,
  openStoreAccount,
  prefix,
  shot,
  wide,
  type Lang,
} from './account-support';

// The web account screens (phase 7 S9): the order history (a table from 1024 px, rows below it,
// a numbered pager), the profile (language through PATCH /me, theme, phone state, devices).

const main = (page: Page) => page.getByRole('main');
// Next's route announcer is a role=alert of its own: the screen's alerts are the ones in <main>.
const alertOf = (page: Page) => main(page).getByRole('alert');
/** The rows of the list, whatever the layout: table links from 1024 px, row links below. */
const rowsOf = (page: Page) => main(page).locator('a[href*="/store/orders/order_"]');

test.describe('history', () => {
  test('success: the table from 1024 px, rows below, a pager with the server total', async ({
    page,
  }, testInfo) => {
    await openStoreAccount(page, '/store/orders');
    const t = account('uz').history;
    await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    if (wide(page)) {
      const table = page.getByRole('table');
      await expect(table).toBeVisible();
      for (const name of [
        t.columns.date,
        t.columns.product,
        t.columns.recipient,
        t.columns.amount,
        t.columns.status,
      ]) {
        await expect(table.getByRole('columnheader', { name })).toBeVisible();
      }
      await expect(table.getByRole('row')).toHaveCount(21);
    } else {
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.getByRole('tabpanel').getByRole('link')).toHaveCount(20);
    }
    await expect(page.getByRole('navigation', { name: t.pager.label })).toContainText(
      'Jami 25 tadan 1–20',
    );
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, 'history-ready-uz');
  });

  test('skeleton, error with a retry, empty with the shop button', async ({ page }, testInfo) => {
    const api = await openStoreAccount(page, '/store/orders', { api: { orders: 'slow' } });
    const t = account('uz').history;
    await expect(page.locator('main [aria-busy="true"]')).toBeVisible();
    await expect(main(page).getByRole('status')).toHaveText(t.loading);
    await shot(page, testInfo, 'history-skeleton-uz');
    api.setOrders('error');
    api.release();
    await expect(alertOf(page)).toContainText(t.error.title);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, 'history-error-uz');
    api.setOrders('empty');
    await page.getByRole('button', { name: 'Qayta urinish' }).click();
    await expect(page.getByText(t.empty.orders.title)).toBeVisible();
    await expect(page.getByRole('link', { name: t.empty.orders.cta })).toHaveAttribute(
      'href',
      '/store',
    );
    await shot(page, testInfo, 'history-empty-uz');
  });

  test('the pager asks for the page that was pressed', async ({ page }) => {
    const api = await openStoreAccount(page, '/store/orders');
    const t = account('uz').history;
    const pager = page.getByRole('navigation', { name: t.pager.label });
    await expect(pager).toContainText('1–20');
    await expect(pager.getByRole('button', { name: t.pager.prev })).toBeDisabled();
    await pager.getByRole('button', { name: '2-sahifa' }).click();
    await expect(pager).toContainText('Jami 25 tadan 21–25');
    await expect(pager.getByRole('button', { name: t.pager.next })).toBeDisabled();
    expect(api.orderRequests.at(-1)?.searchParams.get('page')).toBe('2');
    expect(api.orderRequests.at(-1)?.searchParams.get('limit')).toBe('20');
  });

  test('a chip starts again from the first page with its statuses', async ({ page }) => {
    const api = await openStoreAccount(page, '/store/orders');
    const t = account('uz').history;
    const pager = page.getByRole('navigation', { name: t.pager.label });
    await pager.getByRole('button', { name: '2-sahifa' }).click();
    await expect(pager).toContainText('21–25');
    await page.getByRole('button', { name: t.filter.done }).click();
    await expect.poll(() => api.orderRequests.at(-1)?.searchParams.get('status')).toBe('DELIVERED');
    expect(api.orderRequests.at(-1)?.searchParams.get('page')).toBe('1');
    await expect(rowsOf(page).first()).toBeVisible();
  });

  test('finance: the ledger with its own pager; an entry from an order links to it', async ({
    page,
  }, testInfo) => {
    const api = await openStoreAccount(page, '/store/orders');
    const t = account('uz').history;
    await page.getByRole('tab', { name: t.tabs.finance }).click();
    await expect(page.getByText(t.ledger.kind.PURCHASE).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: t.pager.label })).toContainText(
      'Jami 23 tadan 1–20',
    );
    expect(api.ledgerRequests.at(-1)?.searchParams.get('limit')).toBe('20');
    await expect(page.getByRole('tabpanel').getByRole('link').first()).toHaveAttribute(
      'href',
      '/store/orders/order_1',
    );
    await expect(
      page
        .getByRole('tabpanel')
        .getByText(/\+50.347/)
        .first(),
    ).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, 'finance-ready-uz');
  });

  test('reachable from the header: the link or the account menu', async ({ page }) => {
    await openStoreAccount(page, '/store/profile');
    const t = account('uz');
    if (wide(page)) {
      await page
        .getByRole('navigation', { name: 'Asosiy' })
        .getByRole('link', { name: t.nav.history })
        .click();
    } else {
      await page.getByRole('button', { name: 'Hisob menyusi' }).click();
      await page.getByRole('link', { name: t.nav.history }).click();
    }
    await expect(page).toHaveURL(/\/store\/orders$/);
    await expect(page.getByRole('heading', { level: 1, name: t.history.title })).toBeVisible();
  });
});

test.describe('header language switch', () => {
  // From 1024 px the switch is in the header; below it, inside the account menu.
  async function reach(page: Page) {
    if (!wide(page)) await page.getByRole('button', { name: 'Hisob menyusi' }).click();
    return page.getByRole('banner').getByRole('radio', { name: 'Русский' });
  }

  test('saves with PATCH /me first, then loads the same page in Russian', async ({ page }) => {
    const api = await openStoreAccount(page, '/store/orders');
    await (await reach(page)).click();
    await expect(page).toHaveURL(/\/ru\/store\/orders$/);
    expect(api.patches).toEqual([{ locale: 'ru' }]);
    // The URL changes before the Russian page is drawn: a full load, the session restored and the
    // history asked again. Under a full parallel run that took longer than the default 5 s.
    await expect(
      page.getByRole('heading', { level: 1, name: account('ru').history.title }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('refused: the page stays in Uzbek and a message appears next to the switch', async ({
    page,
  }) => {
    await openStoreAccount(page, '/store/orders', { api: { patchFails: true } });
    await (await reach(page)).click();
    await expect(page.getByRole('banner').getByRole('alert')).toContainText(
      account('uz').profile.language.error,
    );
    await expect(page).toHaveURL(/\/store\/orders$/);
  });
});

test.describe('profile', () => {
  test('identity, balance, phone state, referral link, devices and sign-out (uz / light)', async ({
    page,
  }, testInfo) => {
    await openStoreAccount(page, '/store/profile');
    const t = account('uz').profile;
    await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    await expect(main(page).getByText('@sardor_r')).toBeVisible();
    await expect(page.getByText(t.phone.title)).toBeVisible();
    await expect(page.getByText(t.phone.unlinked)).toBeVisible();
    await expect(page.getByText(/t\.me\/[A-Za-z0-9_]+\?startapp=ref_ref12345/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Faol sessiyalar' })).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Chiqish' })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, 'profile-uz-light');
  });

  test('language: PATCH /me, then the same page under /ru', async ({ page }) => {
    const api = await openStoreAccount(page, '/store/profile');
    await main(page).getByRole('radio', { name: 'Русский' }).click();
    await expect(page).toHaveURL(/\/ru\/store\/profile$/);
    expect(api.patches).toEqual([{ locale: 'ru' }]);
    await expect(
      page.getByRole('heading', { level: 1, name: account('ru').profile.title }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    // The server kept it: the next read of the profile says Russian.
    const me = await page.evaluate(async () => {
      const response = await fetch('http://localhost:5000/api/v1/me', { credentials: 'include' });
      return (await response.json()) as { data: { locale: string } };
    });
    expect(me.data.locale).toBe('ru');
  });

  test('language: a refused PATCH stays on the page with the error', async ({ page }) => {
    await openStoreAccount(page, '/store/profile', { api: { patchFails: true } });
    await main(page).getByRole('radio', { name: 'Русский' }).click();
    await expect(alertOf(page)).toContainText(account('uz').profile.language.error);
    await expect(page).toHaveURL(/\/store\/profile$/);
  });

  test('theme and reduced motion are remembered as UI settings', async ({ page }) => {
    await openStoreAccount(page, '/store/profile');
    const t = account('uz').profile;
    await page.getByRole('radio', { name: t.appearance.theme.dark }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => window.localStorage.getItem('ggpin-theme'))).toBe('dark');
    await page.getByRole('switch', { name: t.settings.reducedMotion.label }).click();
    await expect(page.locator('html')).toHaveAttribute('data-reduced', 'true');
    // (The harness writes its own theme on every load, so the reload checks the motion flag only.)
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-reduced', 'true');
  });

  test('discount codes and the bonus code are entries marked "Tez orada"', async ({ page }) => {
    await openStoreAccount(page, '/store/profile');
    const t = account('uz').profile;
    const card = page.getByRole('region', { name: t.services.title });
    await expect(card.getByText(t.services.soon)).toHaveCount(2);
    await expect(card.getByRole('link')).toHaveCount(0);
  });
});

for (const lang of ['uz', 'ru'] as Lang[]) {
  for (const scheme of SCHEMES) {
    test.describe(`${lang} / ${scheme}`, () => {
      test('history fits, no axe violation', async ({ page }, testInfo) => {
        await openStoreAccount(page, '/store/orders', { lang, scheme });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(
          page.getByRole('navigation', { name: account(lang).history.pager.label }),
        ).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `history-${lang}-${scheme}`);
      });
      test('profile fits, no axe violation', async ({ page }, testInfo) => {
        await openStoreAccount(page, '/store/profile', { lang, scheme });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(main(page).getByText('@sardor_r')).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `profile-${lang}-${scheme}`);
      });
    });
  }
}

test('the Russian page keeps the /ru prefix on its own links', async ({ page }) => {
  await openStoreAccount(page, '/store/orders', { lang: 'ru' });
  expect(prefix('ru')).toBe('/ru');
  await expect(rowsOf(page).first()).toHaveAttribute('href', /^\/ru\/store\/orders\/order_\d+$/);
});
