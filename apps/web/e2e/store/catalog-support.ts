import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Page, TestInfo } from '@playwright/test';
import { installCatalogApi, type CatalogApiOptions } from '../fixtures/catalog';
import { installFakeApi } from '../support/fake-api';

// Shared by catalog.spec.ts and catalog-states.spec.ts: open the web store as a signed-in user.

export const TEXT = { uz, ru } as const;
export type Lang = keyof typeof TEXT;
export const SCHEMES = ['light', 'dark'] as const;
export const prefix = (lang: Lang) => (lang === 'uz' ? '' : '/ru');

export interface Open {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  catalog?: CatalogApiOptions;
  hold?: boolean;
  path?: string;
}

export async function openStore(
  page: Page,
  { lang = 'uz', scheme = 'light', catalog, hold, path = '/store' }: Open = {},
) {
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), scheme);
  await installFakeApi(page, { signedIn: true });
  const api = await installCatalogApi(page, catalog);
  if (hold) api.hold();
  await page.goto(`${prefix(lang)}${path}`);
  return api;
}

export const card = (page: Page, name: string) =>
  page.getByRole('link', { name: new RegExp(name) });
export const searchbox = (page: Page) => page.getByRole('searchbox');
export const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

export async function shot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}
