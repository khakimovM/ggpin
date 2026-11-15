import type { Page } from '@playwright/test';
import { installAccountApi, noonInTashkent, type AccountApiOptions } from '../fixtures/account';
import { installCatalogApi } from '../fixtures/catalog';
import { installFakeApi } from '../support/fake-api';
import { TEXT, prefix, type Lang } from './product-support';

// Shared by the web account specs (phase 7 S9): the order history and the profile, opened as a
// signed-in user with the account fake on top of the sign-in and catalog fakes.

export { SCHEMES, TEXT, prefix, shot, wide, type Lang } from './product-support';

export interface StoreAccountOpen {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  api?: AccountApiOptions;
}

export const account = (lang: Lang) => TEXT[lang].account;

export async function openStoreAccount(
  page: Page,
  path: '/store/orders' | '/store/profile',
  { lang = 'uz', scheme = 'light', api }: StoreAccountOpen = {},
) {
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), scheme);
  await installFakeApi(page, { signedIn: true });
  await installCatalogApi(page);
  // The page clock starts at noon in Tashkent, the moment the fake rows are dated from, so the day
  // headings do not depend on the hour the suite runs (time still flows).
  const now = noonInTashkent();
  await page.clock.install({ time: now });
  const fake = await installAccountApi(page, { ...api, now });
  await page.goto(`${prefix(lang)}${path}`);
  return fake;
}
