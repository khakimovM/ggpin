import { expect, test } from '@playwright/test';
import type { OrderStatus } from '../fixtures/orders';
import { axeViolations, overflow } from '../tg/support';
import { SCHEMES, TEXT, openStoreOrder, prefix, shot, type Lang } from './checkout-support';

// The web order page (phase 7 S7): the statuses, the code of a voucher, the four states. The same
// view as the Mini App's (order.spec.ts under e2e/tg), so this spec checks what is web-only: the
// language prefix, the links, and the layout at every width.

const PRESET = {
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  quantity: 500,
  totalTiyin: '11000000',
} as const;
const o = (lang: Lang) => TEXT[lang].store.order;

const STATES: Array<{
  name: string;
  statuses: OrderStatus[];
  voucher?: string;
  title: (lang: Lang) => string;
}> = [
  { name: 'processing', statuses: ['PROCESSING'], title: (l) => o(l).hero.processing.title },
  { name: 'review', statuses: ['NEEDS_REVIEW'], title: (l) => o(l).hero.review.title },
  { name: 'failed', statuses: ['FAILED'], title: (l) => o(l).hero.failed.title },
  { name: 'refunded', statuses: ['REFUNDED'], title: (l) => o(l).hero.refunded.title },
  { name: 'cancelled', statuses: ['CANCELLED'], title: (l) => o(l).hero.cancelled.title },
  {
    name: 'voucher',
    statuses: ['DELIVERED'],
    voucher: 'XK7Q-92LM-PA3D-8R2T',
    title: (l) => o(l).hero.voucher.title,
  },
  {
    name: 'delivered',
    statuses: ['DELIVERED'],
    title: (l) => o(l).hero.delivered.title.split(' ')[0] ?? '',
  },
];

test.describe('every status, in both languages and themes', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      for (const state of STATES) {
        test(`${state.name} / ${lang} / ${scheme}`, async ({ page }, testInfo) => {
          await openStoreOrder(page, 'order_x', {
            lang,
            scheme,
            orders: { preset: PRESET, statuses: state.statuses, voucher: state.voucher },
          });
          await expect(
            page.getByRole('heading', { level: 1, name: state.title(lang), exact: false }),
          ).toBeVisible();
          expect(await overflow(page)).toBeLessThanOrEqual(0);
          expect(await axeViolations(page)).toEqual([]);
          await shot(page, testInfo, `order-${state.name}-${lang}-${scheme}`);
        });
      }
    }
  }
});

test.describe('links', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: "buy again" and "home" keep the language`, async ({ page }) => {
      await openStoreOrder(page, 'order_x', {
        lang,
        orders: { preset: PRESET, statuses: ['DELIVERED'] },
      });
      await expect(page.getByRole('link', { name: o(lang).actions.again })).toHaveAttribute(
        'href',
        `${prefix(lang)}/store/products/telegram-stars`,
      );
      await page.getByRole('link', { name: o(lang).actions.again }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix(lang)}/store/products/telegram-stars$`));
    });
  }

  test('not found: the way home keeps the language', async ({ page }) => {
    await openStoreOrder(page, 'order_x', { lang: 'ru', orders: { get: 'notFound' } });
    await expect(page.getByText(o('ru').notFound.title)).toBeVisible();
    await expect(page.getByRole('link', { name: o('ru').actions.home })).toHaveAttribute(
      'href',
      '/ru/store',
    );
  });
});

test.describe('the other states', () => {
  test('skeleton while loading', async ({ page }, testInfo) => {
    await openStoreOrder(page, 'order_x', { orders: { preset: PRESET, getDelayMs: 1500 } });
    await expect(page.getByRole('status').first()).toHaveText(o('uz').loading);
    await shot(page, testInfo, 'order-skeleton');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('an error and its retry', async ({ page }, testInfo) => {
    const { orders } = await openStoreOrder(page, 'order_x', {
      orders: { preset: PRESET, get: 'error' },
    });
    await expect(page.getByText(o('uz').error.title)).toBeVisible({ timeout: 20_000 });
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, 'order-error');
    orders.setGet('ok');
    await page.getByRole('button', { name: TEXT.uz.common.retry }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('moves by itself to "Yetkazildi!" and stops asking', async ({ page }) => {
    const { orders } = await openStoreOrder(page, 'order_x', { orders: { preset: PRESET } });
    await expect(page.getByRole('heading', { level: 1, name: /Yetkazildi!/ })).toBeVisible({
      timeout: 20_000,
    });
    const asked = orders.orderGets();
    await page.waitForTimeout(5000);
    expect(orders.orderGets()).toBe(asked);
  });

  test('a voucher code can be copied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openStoreOrder(page, 'order_x', {
      orders: { preset: PRESET, statuses: ['DELIVERED'], voucher: 'XK7Q-92LM-PA3D-8R2T' },
    });
    await page.getByRole('button', { name: o('uz').voucher.copy }).click();
    await expect(page.getByText(o('uz').voucher.copied)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('XK7Q-92LM-PA3D-8R2T');
  });
});
