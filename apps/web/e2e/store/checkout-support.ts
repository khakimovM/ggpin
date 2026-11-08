import { expect, type Page } from '@playwright/test';
import { installCatalogApi, type CatalogApiOptions } from '../fixtures/catalog';
import {
  DEFAULT_BALANCE_TIYIN,
  installOrdersApi,
  type OrdersApi,
  type OrdersApiOptions,
} from '../fixtures/orders';
import { installProductApi, type ProductApi, type ProductApiOptions } from '../fixtures/product';
import { installFakeApi } from '../support/fake-api';
import { buyButton, confirmRecipient, prefix, type Lang } from './product-support';

// Shared by the web checkout and order specs (phase 7 S7): the product page with the orders fake on
// top, and the order page opened directly.

export { TEXT, SCHEMES, prefix, shot, type Lang } from './product-support';

export interface StoreCheckoutOpen {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  catalog?: CatalogApiOptions;
  product?: ProductApiOptions;
  orders?: OrdersApiOptions;
  /** Fake clock on the page (time still flows); move it with `page.clock.fastForward`. */
  clock?: boolean;
}

export interface StoreFakes {
  product: ProductApi;
  orders: OrdersApi;
}

async function install(page: Page, opts: StoreCheckoutOpen): Promise<StoreFakes> {
  const { scheme = 'light' } = opts;
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), scheme);
  await installFakeApi(page, { signedIn: true });
  // The wallet of the catalog fake and the balance of the orders fake are the same number.
  await installCatalogApi(page, {
    balanceTiyin: opts.orders?.balanceTiyin ?? DEFAULT_BALANCE_TIYIN,
    ...opts.catalog,
  });
  const product = await installProductApi(page, opts.product);
  const orders = await installOrdersApi(page, product, opts.orders);
  if (opts.clock) await page.clock.install();
  return { product, orders };
}

export async function openStoreProduct(page: Page, slug: string, opts: StoreCheckoutOpen = {}) {
  const fakes = await install(page, opts);
  await page.goto(`${prefix(opts.lang ?? 'uz')}/store/products/${slug}`);
  return fakes;
}

export async function openStoreOrder(page: Page, id: string, opts: StoreCheckoutOpen = {}) {
  const fakes = await install(page, opts);
  await page.goto(`${prefix(opts.lang ?? 'uz')}/store/orders/${id}`);
  return fakes;
}

/** Confirms the recipient, waits for the live quote and presses "Sotib olish". */
export async function reachStoreConfirm(page: Page, lang: Lang = 'uz', username = 'aziz_k') {
  await confirmRecipient(page, lang, username);
  const buy = buyButton(page, lang);
  await expect(buy).toBeEnabled();
  await buy.click();
}
