import type { Page } from '@playwright/test';
import { tgCalls } from '../fixtures/telegram';
import { installCatalogApi } from '../fixtures/catalog';
import { installPaymentsApi, type PaymentsApiOptions } from '../fixtures/payments';
import { installFakeWebApp } from '../fixtures/telegram';
import { installTgApi } from '../fixtures/tg-api';
import { TEXT, type Lang } from './product-support';
import { INIT_DATA } from './support';

// Shared by the Mini App top-up specs (phase 7 S8): opened as a signed-in user, with the payments
// fake on top of the catalog (wallet) and sign-in fakes.

export { SCHEMES, TEXT, type Lang } from './product-support';

export interface TopupOpen {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  path?: string;
  payments?: PaymentsApiOptions;
  /** The first N `openLink` calls throw: a client that refuses the call. */
  refusals?: number;
}

export const tgTopup = (lang: Lang) => TEXT[lang].tg.topup;
export const storeTopup = (lang: Lang) => TEXT[lang].store.topup;

export async function openTopup(
  page: Page,
  { lang = 'uz', scheme = 'light', path = '/tg/topup', payments, refusals }: TopupOpen = {},
) {
  await installFakeWebApp(page, {
    initData: INIT_DATA,
    colorScheme: scheme,
    languageCode: lang,
    openLinkRefusals: refusals,
  });
  await installTgApi(page, [{ kind: 'ok', user: { locale: lang } }]);
  await installCatalogApi(page);
  const api = await installPaymentsApi(page, payments);
  await page.goto(path);
  return api;
}

/** Every URL the Mini App handed to `openLink`, in order. */
export async function openLinks(page: Page): Promise<string[]> {
  return (await tgCalls(page))
    .filter(([name]) => name === 'openLink')
    .map(([, url]) => String(url));
}

/** The native main button's calls (text, enable, disable, ...). */
export async function mainButtonCalls(page: Page) {
  return (await tgCalls(page)).filter(([name]) => name.startsWith('MainButton.'));
}
