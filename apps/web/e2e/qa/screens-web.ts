import { expect } from '@playwright/test';
import { openPay } from '../pay/pay-support';
import { openLanding } from '../site/landing-support';
import { installFakeApi } from '../support/fake-api';
import { openStoreAccount } from '../store/account-support';
import { openStore } from '../store/catalog-support';
import { openStoreOrder, openStoreProduct, reachStoreConfirm } from '../store/checkout-support';
import { confirmRecipient } from '../store/product-support';
import { openModal } from '../store/topup-support';
import { dialogUp, h1, PRESET, type Screen } from './screens-mini';

// The web half of the S11 matrix screen list: the store, the pay page, the login and the 404.

export const WEB: Screen[] = [
  {
    // The landing (phase 8 S2), served by the main fixture catalog (all products live).
    name: 'site-landing',
    open: async ({ page, lang, scheme }) => {
      await page.addInitScript((s) => window.localStorage.setItem('ggpin-theme', s), scheme);
      await openLanding(page, lang);
    },
  },
  {
    name: 'store-catalog',
    open: async ({ page, lang, scheme }) => {
      await openStore(page, { lang, scheme });
      await h1(page);
      await expect(page.getByRole('list').getByRole('listitem').first()).toBeVisible();
    },
  },
  ...(['telegram-stars', 'telegram-premium'] as const).map((slug): Screen => ({
    name: `store-product-${slug.replace('telegram-', '')}`,
    open: async ({ page, lang, scheme }) => {
      await openStoreProduct(page, slug, { lang, scheme });
      await confirmRecipient(page, lang);
      await h1(page);
    },
  })),
  {
    name: 'store-confirm',
    open: async ({ page, lang, scheme }) => {
      await openStoreProduct(page, 'telegram-stars', { lang, scheme });
      await reachStoreConfirm(page, lang);
      await dialogUp(page);
    },
  },
  {
    name: 'store-insufficient',
    open: async ({ page, lang, scheme }) => {
      const orders = { balanceTiyin: '500000' };
      await openStoreProduct(page, 'telegram-stars', { lang, scheme, orders });
      await reachStoreConfirm(page, lang);
      // The server answers the payment with the numbers; the sheet that follows is its answer.
      await page.getByRole('dialog').getByRole('button').last().click();
      await expect(page.getByRole('dialog').getByRole('heading').first()).toBeVisible();
    },
  },
  {
    name: 'store-topup',
    open: async ({ page, lang, scheme }) => {
      await openModal(page, lang, undefined, scheme);
    },
  },
  ...(['PROCESSING', 'DELIVERED'] as const).map((status): Screen => ({
    name: `store-order-${status.toLowerCase()}`,
    open: async ({ page, lang, scheme }) => {
      await openStoreOrder(page, 'order_x', {
        lang,
        scheme,
        orders: { preset: PRESET, statuses: [status] },
      });
      await h1(page);
    },
  })),
  ...(
    [
      ['orders', 'store-history'],
      ['profile', 'store-profile'],
    ] as const
  ).map(([leaf, name]): Screen => ({
    name,
    open: async ({ page, lang, scheme }) => {
      await openStoreAccount(page, `/store/${leaf}`, { lang, scheme });
      await h1(page);
    },
  })),
  {
    name: 'pay-pending',
    open: async ({ page, lang, scheme }) => {
      await openPay(page, { lang, scheme });
      await expect(page.getByTestId('pay-amount')).toBeVisible();
    },
  },
  {
    name: 'pay-credited',
    open: async ({ page, lang, scheme }) => {
      const api = await openPay(page, { lang, scheme });
      await expect(page.getByTestId('pay-amount')).toBeVisible();
      api.setStatus('PAID');
      await expect(page.locator('[data-final="credited"]')).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: 'pay-invalid',
    open: async ({ page, lang, scheme }) => {
      await openPay(page, { lang, scheme, payments: { payView: 'notFound' } });
      await expect(page.locator('[data-final="invalid"]')).toBeVisible();
    },
  },
  ...(['start', 'code'] as const).map((state): Screen => ({
    name: `login-${state}`,
    open: async ({ page, lang, scheme }) => {
      await page.addInitScript((s) => window.localStorage.setItem('ggpin-theme', s), scheme);
      await installFakeApi(page, state === 'code' ? { statuses: ['CODE_SENT'] } : {});
      await page.goto(lang === 'uz' ? '/login' : '/ru/login');
      await expect(page.getByRole('button').first()).toBeVisible({ timeout: 15_000 });
      if (state === 'code') {
        await page.getByRole('button').first().click();
        await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 15_000 });
      }
    },
  })),
  {
    name: 'web-404',
    open: async ({ page, lang, scheme }) => {
      await page.addInitScript((s) => window.localStorage.setItem('ggpin-theme', s), scheme);
      await page.goto(lang === 'uz' ? '/nonexistent' : '/ru/nonexistent');
      await h1(page);
    },
  },
];
