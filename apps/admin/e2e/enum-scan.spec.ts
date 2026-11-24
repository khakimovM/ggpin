import { expect, test } from '@playwright/test';
import { seedMock } from './support/mock';

// Owner, 2026-11-23: no raw enum on screen. Every visible text node of every screen (code and ids
// in monospace, raw JSON in <pre>, the role and environment badges excepted) is scanned for an
// UPPER_SNAKE word or a bare single-word state name.
const PAGES = [
  '/dashboard',
  '/orders',
  '/orders?status=NEEDS_REVIEW',
  '/orders/mkord000001',
  '/orders/mkord000002',
  '/review',
  '/review?status=HELD',
  '/users',
  '/users/mkuser000001',
  '/products',
  '/products/mkprod000001?sku=mksku000001',
  '/products/mkprod000003',
  '/pricing',
  '/payments',
  '/payments?tab=intents',
  '/payments?tab=cards',
  '/recon',
  '/wallet',
  '/fragment',
  '/queues',
  '/audit',
  '/audit?entry=mkaud000001',
  '/admins',
] as const;

const SINGLE_WORDS = [
  'PAID',
  'QUEUED',
  'PROCESSING',
  'HELD',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PENDING',
  'EXPIRED',
  'CONFIRMED',
  'SENT',
  'SYSTEM',
  'RECONCILER',
  'WORKER',
  'DEGRADED',
  'DOWN',
  'UNKNOWN',
  'ACTIVE',
  'DEAD',
  'VOUCHER',
];

// The brand badge (ggpin ADMIN), admin roles and the environment badge are names, not states (shell design).
const ALLOWED = ['ADMIN', 'OWNER', 'OPERATOR', 'SUPPORT', 'STAGING', 'MOCK', 'DEV', 'PROD'];

for (const path of PAGES) {
  test(`no raw enum on ${path}`, async ({ page }) => {
    await seedMock(page, { signedIn: true, role: 'OWNER' });
    await page.goto(path);
    // A drawer opened from the URL hides the page heading from the accessibility tree.
    await expect(
      page.getByRole('heading', { level: 1 }).or(page.getByRole('dialog')).first(),
    ).toBeVisible();
    await expect(page.locator('[role="status"][aria-label]')).toHaveCount(0);
    const found = await page.evaluate(
      ([words, allowed]) => {
        const snake = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
        const single = new RegExp(`^(${words.join('|')})$`);
        const skip = 'pre, code, .font-mono, script, style';
        const hits: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const text = node.textContent?.trim() ?? '';
          const parent = node.parentElement;
          if (text === '' || parent === null || parent.closest(skip) !== null) continue;
          // A filter's <option> is read even while its list is closed (CR A6).
          const option = parent.closest('option') !== null;
          const style = window.getComputedStyle(parent);
          if (!option && (style.display === 'none' || style.visibility === 'hidden')) continue;
          if (parent.closest('.sr-only') !== null) continue;
          if (allowed.includes(text)) continue;
          if (snake.test(text) || single.test(text)) hits.push(text);
        }
        return hits;
      },
      [SINGLE_WORDS, ALLOWED] as const,
    );
    expect(found).toEqual([]);
  });
}
