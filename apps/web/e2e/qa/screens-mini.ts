import { expect, type Page } from '@playwright/test';
import { INTENT_ID } from '../fixtures/payments';
import { installFakeWebApp, tgPressMain } from '../fixtures/telegram';
import { installTgApi } from '../fixtures/tg-api';
import { openAccount } from '../tg/account-support';
import { openCheckout, openOrderPage, reachConfirm } from '../tg/checkout-support';
import { openHome } from '../tg/home-support';
import { confirmRecipient, openProduct } from '../tg/product-support';
import { INIT_DATA } from '../tg/support';
import { openTopup } from '../tg/topup-support';

// The Mini App half of the S11 matrix screen list. Each opener puts the screen in its main state
// and waits for something that proves it is drawn.

export type Lang = 'uz' | 'ru';
export type Scheme = 'light' | 'dark';
export interface Ctx {
  page: Page;
  lang: Lang;
  scheme: Scheme;
}
export interface Screen {
  name: string;
  open: (ctx: Ctx) => Promise<void>;
}

export const h1 = (page: Page) => expect(page.getByRole('heading', { level: 1 })).toBeVisible();
export const dialogUp = (page: Page) => expect(page.getByRole('dialog')).toBeVisible();
export const PRESET = {
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  quantity: 500,
  totalTiyin: '11000000',
} as const;
const tick = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

const gate = async (
  { page, lang, scheme }: Ctx,
  initData: string,
  answers?: Parameters<typeof installTgApi>[1],
  path = '/tg',
) => {
  await installFakeWebApp(page, { initData, colorScheme: scheme, languageCode: lang });
  await installTgApi(page, answers);
  await page.goto(path);
  await h1(page);
};

export const MINI: Screen[] = [
  {
    name: 'tg-home',
    open: async ({ page, lang, scheme }) => {
      await openHome(page, { lang, scheme });
      await h1(page);
      await expect(page.getByRole('list').getByRole('listitem').first()).toBeVisible();
    },
  },
  { name: 'tg-gate-bot', open: (ctx) => gate(ctx, '') },
  {
    name: 'tg-gate-blocked',
    open: (ctx) => gate(ctx, INIT_DATA, [{ kind: 'error', status: 403, code: 'USER_BLOCKED' }]),
  },
  {
    name: 'tg-404',
    open: (ctx) =>
      gate(ctx, INIT_DATA, [{ kind: 'ok', user: { locale: ctx.lang } }], '/tg/nonexistent'),
  },
  {
    name: 'tg-product-stars',
    open: async ({ page, lang, scheme }) => {
      await openProduct(page, 'telegram-stars', { lang, scheme });
      await confirmRecipient(page, lang);
      await h1(page);
    },
  },
  {
    name: 'tg-product-premium',
    open: async ({ page, lang, scheme }) => {
      await openProduct(page, 'telegram-premium', { lang, scheme });
      await confirmRecipient(page, lang);
      await h1(page);
    },
  },
  {
    name: 'tg-confirm',
    open: async ({ page, lang, scheme }) => {
      await openCheckout(page, 'telegram-stars', { lang, scheme });
      await reachConfirm(page, lang);
      await dialogUp(page);
    },
  },
  {
    name: 'tg-insufficient',
    open: async ({ page, lang, scheme }) => {
      await openCheckout(page, 'telegram-stars', {
        lang,
        scheme,
        orders: { balanceTiyin: '500000' },
      });
      await reachConfirm(page, lang);
      await tgPressMain(page);
      await expect(page.getByRole('dialog').getByRole('button').first()).toBeVisible();
    },
  },
  {
    name: 'tg-topup',
    open: async ({ page, lang, scheme }) => {
      await openTopup(page, { lang, scheme });
      await h1(page);
    },
  },
  {
    name: 'tg-topup-waiting',
    open: async ({ page, lang, scheme }) => {
      const path = `/tg/topup/${INTENT_ID}`;
      await openTopup(page, { lang, scheme, path, payments: { preset: true } });
      await h1(page);
    },
  },
  {
    name: 'tg-topup-credited',
    open: async ({ page, lang, scheme }) => {
      const path = `/tg/topup/${INTENT_ID}?from=%2Ftg%2Fproducts%2Ftelegram-stars`;
      const api = await openTopup(page, { lang, scheme, path, payments: { preset: true } });
      await h1(page);
      api.setStatus('PAID');
      await tick(page);
      await expect(page.locator('main')).toContainText(/\+50\s347/, { timeout: 15_000 });
    },
  },
  ...(['PROCESSING', 'DELIVERED'] as const).map((status): Screen => ({
    name: `tg-order-${status.toLowerCase()}`,
    open: async ({ page, lang, scheme }) => {
      await openOrderPage(page, 'order_x', {
        lang,
        scheme,
        orders: { preset: PRESET, statuses: [status] },
      });
      await h1(page);
    },
  })),
  ...(['history', 'profile', 'referral', 'help'] as const).map((leaf): Screen => ({
    name: `tg-${leaf}`,
    open: async ({ page, lang, scheme }) => {
      await openAccount(page, `/tg/${leaf}`, { lang, scheme });
      await h1(page);
    },
  })),
];
