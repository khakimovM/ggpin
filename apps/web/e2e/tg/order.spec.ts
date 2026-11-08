import { expect, test } from '@playwright/test';
import type { OrderStatus } from '../fixtures/orders';
import { axeViolations, overflow } from './support';
import { TEXT, attachShot, openOrderPage, type Lang } from './checkout-support';

// The Mini App order page (phase 7 S7): every status of Checkout.dc.html `order`, the live updates,
// the code of a voucher and the four states of the page. The checkout itself is in checkout.spec.ts.

const PRESET = {
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  quantity: 500,
  totalTiyin: '11000000',
} as const;
const o = (lang: Lang) => TEXT[lang].store.order;

/** The first word of a title as a pattern (the titles carry an emoji or a mark). */
const starts = (title: string) =>
  new RegExp(`^${(title.split(' ')[0] ?? '').replace(/[!.*+?^${}()|[\]\\]/g, '\\$&')}`);

interface Case {
  name: string;
  statuses: OrderStatus[];
  voucher?: string;
  hero: (lang: Lang) => RegExp;
  chip: (lang: Lang) => string;
  steps: string[];
}

const CASES: Case[] = [
  {
    name: 'paid',
    statuses: ['PAID'],
    hero: (l) => new RegExp(`^${o(l).hero.paid.title}$`),
    chip: (l) => o(l).status.queued,
    steps: ['active', 'pending', 'pending', 'pending'],
  },
  {
    name: 'queued',
    statuses: ['PAID', 'QUEUED'],
    hero: (l) => new RegExp(`^${o(l).hero.queued.title}$`),
    chip: (l) => o(l).status.queued,
    steps: ['done', 'active', 'pending', 'pending'],
  },
  {
    name: 'processing',
    statuses: ['PAID', 'QUEUED', 'PROCESSING'],
    hero: (l) => new RegExp(`^${o(l).hero.processing.title}$`),
    chip: (l) => o(l).status.processing,
    steps: ['done', 'done', 'active', 'pending'],
  },
  {
    name: 'delivered',
    statuses: ['PAID', 'QUEUED', 'PROCESSING', 'DELIVERED'],
    hero: (l) => starts(o(l).hero.delivered.title),
    chip: (l) => o(l).status.delivered,
    steps: ['done', 'done', 'done', 'done'],
  },
  {
    name: 'voucher',
    statuses: ['PAID', 'QUEUED', 'PROCESSING', 'DELIVERED'],
    voucher: 'XK7Q-92LM-PA3D-8R2T',
    hero: (l) => starts(o(l).hero.voucher.title),
    chip: (l) => o(l).status.delivered,
    steps: ['done', 'done', 'done', 'done'],
  },
  {
    name: 'review',
    statuses: ['PAID', 'QUEUED', 'NEEDS_REVIEW'],
    hero: (l) => new RegExp(`^${o(l).hero.review.title}$`),
    chip: (l) => o(l).status.review,
    steps: ['done', 'done', 'active', 'pending'],
  },
  {
    name: 'failed',
    statuses: ['PAID', 'QUEUED', 'PROCESSING', 'FAILED'],
    hero: (l) => new RegExp(`^${o(l).hero.failed.title}$`),
    chip: (l) => o(l).status.refunded,
    steps: ['done', 'done', 'done', 'done', 'done'],
  },
  {
    name: 'refunded',
    // FAILED settles the page, so the history is just the last status: paid, failed, refunded
    statuses: ['REFUNDED'],
    hero: (l) => new RegExp(`^${o(l).hero.refunded.title}$`),
    chip: (l) => o(l).status.refunded,
    steps: ['done', 'done', 'done'],
  },
  {
    name: 'cancelled',
    statuses: ['PAID', 'CANCELLED'],
    hero: (l) => new RegExp(`^${o(l).hero.cancelled.title}$`),
    chip: (l) => o(l).status.cancelled,
    steps: ['done', 'done', 'done'],
  },
];

// A page opened on a settled status must not ask for another: the fake repeats the last one.
const settled = (statuses: OrderStatus[]) => [statuses[statuses.length - 1] as OrderStatus];

test.describe('every status', () => {
  for (const item of CASES) {
    test(`${item.name}: hero, chip, steps (uz / light)`, async ({ page }, testInfo) => {
      await openOrderPage(page, 'order_x', {
        orders: {
          preset: PRESET,
          // The steps of the timeline come from the history; the page shows the latest status.
          statuses: item.statuses,
          voucher: item.voucher,
        },
      });
      // Jump to the last status of the history (a poll asks again until it settles).
      await expect(page.getByRole('heading', { level: 1, name: item.hero('uz') })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator('[data-hero]')).toHaveCount(1);
      const chip = page.getByText(item.chip('uz'), { exact: true }).first();
      await expect(chip).toBeVisible();
      const steps = page.getByRole('list', { name: o('uz').timeline.label }).getByRole('listitem');
      await expect(steps).toHaveCount(item.steps.length);
      expect(
        await steps.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-state'))),
      ).toEqual(item.steps);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `order-${item.name}-uz`);
    });
  }

  for (const name of ['processing', 'delivered', 'voucher', 'failed']) {
    test(`${name}: Russian, dark - fits, no overflow, no axe violation`, async ({
      page,
    }, testInfo) => {
      const item = CASES.find((c) => c.name === name) as Case;
      await openOrderPage(page, 'order_x', {
        lang: 'ru',
        scheme: 'dark',
        orders: { preset: PRESET, statuses: item.statuses, voucher: item.voucher },
      });
      await expect(page.getByRole('heading', { level: 1, name: item.hero('ru') })).toBeVisible({
        timeout: 20_000,
      });
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      await attachShot(page, testInfo, `order-${name}-ru-dark`);
    });
  }
});

test.describe('live', () => {
  test('moves by itself to "Yetkazildi!" and then stops asking', async ({ page }) => {
    const { orders } = await openOrderPage(page, 'order_x', { orders: { preset: PRESET } });
    await expect(
      page.getByRole('heading', { level: 1, name: o('uz').hero.paid.title }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: /Yetkazildi!/ })).toBeVisible({
      timeout: 20_000,
    });
    const asked = orders.orderGets();
    await page.waitForTimeout(5000);
    expect(orders.orderGets()).toBe(asked);
  });

  test('the confetti is claimed once per order: the flag holds nothing but "1"', async ({
    page,
  }) => {
    await openOrderPage(page, 'order_x', {
      orders: { preset: PRESET, statuses: settled(CASES[3]?.statuses ?? []) },
    });
    await expect(page.getByRole('heading', { level: 1, name: /Yetkazildi!/ })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.sessionStorage.getItem('ggpin:burst:order_x')))
      .toBe('1');
    expect(await page.evaluate(() => Object.keys(window.sessionStorage))).toEqual([
      'ggpin:burst:order_x',
    ]);
  });
});

test.describe('the code of a voucher', () => {
  test('is shown, can be copied, and says to keep it to yourself', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openOrderPage(page, 'order_x', {
      orders: { preset: PRESET, statuses: ['DELIVERED'], voucher: 'XK7Q-92LM-PA3D-8R2T' },
    });
    await expect(page.getByTestId('voucher-code')).toHaveText('XK7Q-92LM-PA3D-8R2T');
    await expect(page.getByText(o('uz').voucher.hide)).toBeVisible();
    await page.getByRole('button', { name: o('uz').voucher.copy }).click();
    await expect(page.getByText(o('uz').voucher.copied)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('XK7Q-92LM-PA3D-8R2T');
    // The code is in no address and in no storage.
    expect(page.url()).not.toContain('XK7Q');
    expect(
      await page.evaluate(() => JSON.stringify([window.localStorage, window.sessionStorage])),
    ).not.toContain('XK7Q');
  });
});

test.describe('the four states', () => {
  test('skeleton while loading', async ({ page }, testInfo) => {
    await openOrderPage(page, 'order_x', { orders: { preset: PRESET, getDelayMs: 1500 } });
    await expect(page.getByRole('status').first()).toHaveText(o('uz').loading);
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    await attachShot(page, testInfo, 'order-skeleton');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('an error and its retry', async ({ page }, testInfo) => {
    const { orders } = await openOrderPage(page, 'order_x', {
      orders: { preset: PRESET, get: 'error' },
    });
    await expect(page.getByText(o('uz').error.title)).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'order-error');
    orders.setGet('ok');
    await page.getByRole('button', { name: TEXT.uz.common.retry }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test("not found (somebody else's order looks the same) with the way home", async ({
    page,
  }, testInfo) => {
    await openOrderPage(page, 'order_x', { orders: { get: 'notFound' } });
    await expect(page.getByText(o('uz').notFound.title)).toBeVisible();
    await expect(page.getByRole('link', { name: o('uz').actions.home })).toHaveAttribute(
      'href',
      '/tg',
    );
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'order-notfound');
  });
});

test.describe('what to do next', () => {
  test('delivered: "Yana xarid qilish" leads back to the product', async ({ page }) => {
    await openOrderPage(page, 'order_x', { orders: { preset: PRESET, statuses: ['DELIVERED'] } });
    await page.getByRole('link', { name: o('uz').actions.again }).click();
    await expect(page).toHaveURL(/\/tg\/products\/telegram-stars$/);
  });

  test('in progress: the way home, and the note that closing the app is fine', async ({ page }) => {
    await openOrderPage(page, 'order_x', { orders: { preset: PRESET, statuses: ['PROCESSING'] } });
    await expect(page.getByText(o('uz').leaveNote)).toBeVisible();
    await page.getByRole('link', { name: o('uz').actions.home }).click();
    await expect(page).toHaveURL(/\/tg$/);
  });
});
