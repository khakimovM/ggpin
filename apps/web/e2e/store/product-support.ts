import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Page, TestInfo } from '@playwright/test';
import { installCatalogApi, type CatalogApiOptions } from '../fixtures/catalog';
import { installProductApi, type ProductApiOptions } from '../fixtures/product';
import { installFakeApi } from '../support/fake-api';

// Shared by the web store product specs: open /store/products/<slug> as a signed-in user.

export const TEXT = { uz, ru } as const;
export type Lang = keyof typeof TEXT;
export const SCHEMES = ['light', 'dark'] as const;
export const prefix = (lang: Lang) => (lang === 'uz' ? '' : '/ru');
export const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

export interface Open {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  catalog?: CatalogApiOptions;
  product?: ProductApiOptions;
  hold?: boolean;
}

export async function openProductPage(
  page: Page,
  slug: string,
  { lang = 'uz', scheme = 'light', catalog, product, hold }: Open = {},
) {
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), scheme);
  await installFakeApi(page, { signedIn: true });
  await installCatalogApi(page, catalog);
  const api = await installProductApi(page, product);
  if (hold) api.hold();
  await page.goto(`${prefix(lang)}/store/products/${slug}`);
  return api;
}

/** The visible buy button: the bottom bar below 1024 px, the panel's block from 1024 px. */
export function buyButton(page: Page, lang: Lang) {
  const t = TEXT[lang].store.product;
  const names = [
    t.buy.label,
    t.buy.needRecipient,
    t.buy.needPackage,
    t.buy.needPrice,
    t.quote.expired,
  ];
  return page.getByRole('button', { name: new RegExp(`^(${names.join('|')})`) });
}

export const usernameField = (page: Page) => page.getByRole('textbox', { name: /username/i });

export async function confirmRecipient(page: Page, lang: Lang = 'uz', username = 'aziz_k') {
  const t = TEXT[lang].store.product.recipient;
  await usernameField(page).fill(username);
  await page.getByRole('button', { name: t.check, exact: true }).click();
  await page.getByRole('button', { name: t.confirm, exact: true }).click();
}

export async function shot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}
