import type { Page } from '@playwright/test';
import { installAccountApi, type AccountApiOptions } from '../fixtures/account';
import { installCatalogApi } from '../fixtures/catalog';
import { installFakeWebApp } from '../fixtures/telegram';
import { installTgApi } from '../fixtures/tg-api';
import { TEXT, type Lang } from './product-support';
import { INIT_DATA } from './support';

// Shared by the Mini App account specs (phase 7 S9): history, profile, referral and help, opened
// as a signed-in user with the account fake on top of the catalog and sign-in fakes.

export { SCHEMES, TEXT, attachShot, type Lang } from './product-support';

export interface AccountOpen {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  api?: AccountApiOptions;
}

export const account = (lang: Lang) => TEXT[lang].account;

export async function openAccount(
  page: Page,
  path: '/tg/history' | '/tg/profile' | '/tg/referral' | '/tg/help',
  { lang = 'uz', scheme = 'light', api }: AccountOpen = {},
) {
  await installFakeWebApp(page, { initData: INIT_DATA, colorScheme: scheme, languageCode: lang });
  await installTgApi(page, [{ kind: 'ok', user: { locale: lang } }]);
  await installCatalogApi(page);
  const fake = await installAccountApi(page, api);
  await page.goto(path);
  return fake;
}
