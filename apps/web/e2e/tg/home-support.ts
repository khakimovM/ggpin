import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Page, TestInfo } from '@playwright/test';
import { installCatalogApi, type CatalogApiOptions } from '../fixtures/catalog';
import { installFakeWebApp } from '../fixtures/telegram';
import { installTgApi } from '../fixtures/tg-api';
import { INIT_DATA } from './support';

// Shared by home.spec.ts and home-states.spec.ts: open the Mini App home as a signed-in user.

export const TEXT = { uz, ru } as const;
export type Lang = keyof typeof TEXT;
export const SCHEMES = ['light', 'dark'] as const;

export interface Open {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  catalog?: CatalogApiOptions;
  hold?: boolean;
}

export async function openHome(
  page: Page,
  { lang = 'uz', scheme = 'light', catalog, hold }: Open = {},
) {
  await installFakeWebApp(page, { initData: INIT_DATA, colorScheme: scheme, languageCode: lang });
  await installTgApi(page, [{ kind: 'ok', user: { locale: lang } }]);
  const api = await installCatalogApi(page, catalog);
  if (hold) api.hold();
  await page.goto('/tg');
  return api;
}

export const chip = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
export const card = (page: Page, name: string) =>
  page.getByRole('link', { name: new RegExp(name) });

// Money in the page uses a narrow no-break space between the thousands; any single character will do.
export const AMOUNT_5500 = '5.500';

export async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}
