import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { seedMock } from './support/mock';

// Every read screen in the mock's `empty` and `error` scenarios (R-16): one row per screen, so a
// screen that forgets a state fails by name. Texts come from the admin catalog by key, the same
// strings the screens render.

const catalog: unknown = JSON.parse(
  readFileSync(new URL('../../../packages/i18n/admin.uz.json', import.meta.url), 'utf8'),
);

function msg(key: string): string {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    node = typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined;
  }
  if (typeof node !== 'string') throw new Error(`no catalog text for ${key}`);
  return node;
}

/** [path, the empty state's text key]. */
const EMPTY: readonly [string, string][] = [
  ['/dashboard', 'admin.dashboard.alerts.none'],
  ['/orders', 'admin.orders.empty'],
  ['/review', 'admin.review.empty'],
  ['/users', 'admin.users.emptyList'],
  ['/users/mkuser000001', 'admin.users.empty.orders'],
  ['/products', 'admin.catalog.empty'],
  ['/pricing', 'admin.pricing.empty'],
  ['/payments', 'admin.payments.empty.reviews'],
  ['/payments?tab=payments', 'admin.payments.empty.payments'],
  ['/payments?tab=intents', 'admin.payments.empty.intents'],
  ['/payments?tab=cards', 'admin.payments.empty.cards'],
  ['/recon', 'admin.recon.empty'],
  ['/wallet', 'admin.wallet.empty'],
  ['/fragment', 'admin.fragment.status.NONE'],
  ['/queues', 'admin.queues.empty'],
  ['/audit', 'admin.audit.empty'],
  ['/admins', 'admin.admins.empty'],
];

const ERROR: readonly string[] = [
  '/dashboard',
  '/orders',
  '/orders/mkord000001',
  '/review',
  '/users',
  '/users/mkuser000001',
  '/products',
  '/products/mkprod000001',
  '/pricing',
  '/payments',
  '/payments?tab=payments',
  '/payments?tab=intents',
  '/payments?tab=cards',
  '/recon',
  '/wallet',
  '/fragment',
  '/queues',
  '/audit',
  '/admins',
];

test.describe('empty state of every read screen', () => {
  for (const [path, key] of EMPTY) {
    test(path, async ({ page }) => {
      await seedMock(page, { signedIn: true, role: 'OWNER', scenario: 'empty' });
      await page.goto(path);
      await expect(page.getByText(msg(key)).filter({ visible: true }).first()).toBeVisible();
      await expect(page.getByRole('alert').getByText(msg('admin.states.loadFailed'))).toHaveCount(
        0,
      );
    });
  }
});

test.describe('error state of every read screen', () => {
  for (const path of ERROR) {
    test(path, async ({ page }) => {
      // A 5xx is retried twice with backoff (lib/query-client.ts) before the error state shows.
      test.slow();
      await seedMock(page, { signedIn: true, role: 'OWNER', scenario: 'error' });
      await page.goto(path);
      const alert = page.getByRole('alert').filter({ hasText: msg('admin.states.loadFailed') });
      await expect(alert.first()).toBeVisible({ timeout: 15_000 });
      await expect(
        alert.first().getByRole('button', { name: msg('admin.states.retry') }),
      ).toBeVisible();
    });
  }
});
