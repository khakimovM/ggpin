import { expect, type Page } from '@playwright/test';
import { installCatalogApi, type CatalogApiOptions } from '../fixtures/catalog';
import {
  DEFAULT_BALANCE_TIYIN,
  installOrdersApi,
  type OrdersApi,
  type OrdersApiOptions,
} from '../fixtures/orders';
import { installProductApi, type ProductApi, type ProductApiOptions } from '../fixtures/product';
import { installFakeWebApp, tgPressMain } from '../fixtures/telegram';
import { installTgApi } from '../fixtures/tg-api';
import { INIT_DATA } from './support';
import { confirmRecipient, mainButton, type Lang } from './product-support';

// Shared by the Mini App checkout and order specs (phase 7 S7): the product page with the orders
// fake on top, and the order page opened directly.

export { TEXT, SCHEMES, attachShot, mainButton, type Lang } from './product-support';

export interface CheckoutOpen {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  catalog?: CatalogApiOptions;
  product?: ProductApiOptions;
  orders?: OrdersApiOptions;
  /** Fake clock on the page (time still flows); move it with `page.clock.fastForward`. */
  clock?: boolean;
}

export interface Fakes {
  product: ProductApi;
  orders: OrdersApi;
}

export async function install(page: Page, opts: CheckoutOpen): Promise<Fakes> {
  const { lang = 'uz', scheme = 'light' } = opts;
  await installFakeWebApp(page, { initData: INIT_DATA, colorScheme: scheme, languageCode: lang });
  await installTgApi(page, [{ kind: 'ok', user: { locale: lang } }]);
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

/** Opens a product page as a signed-in Mini App user. */
export async function openCheckout(page: Page, slug: string, opts: CheckoutOpen = {}) {
  const fakes = await install(page, opts);
  await page.goto(`/tg/products/${slug}`);
  return fakes;
}

/** Opens an order page directly (the fake answers for any id when it has a `preset`). */
export async function openOrderPage(page: Page, id: string, opts: CheckoutOpen = {}) {
  const fakes = await install(page, opts);
  await page.goto(`/tg/orders/${id}`);
  return fakes;
}

/** Confirms the recipient, waits for the live quote, and presses Telegram's MainButton. */
export async function reachConfirm(page: Page, lang: Lang = 'uz') {
  await confirmRecipient(page, lang);
  await expect.poll(() => mainButton(page)).toMatchObject({ enabled: true });
  await tgPressMain(page);
}
