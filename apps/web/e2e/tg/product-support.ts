import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Page, TestInfo } from '@playwright/test';
import { installCatalogApi, type CatalogApiOptions } from '../fixtures/catalog';
import { installProductApi, type ProductApiOptions } from '../fixtures/product';
import { installFakeWebApp, tgCalls } from '../fixtures/telegram';
import { installTgApi } from '../fixtures/tg-api';
import { INIT_DATA } from './support';

// Shared by the Mini App product specs: open /tg/products/<slug> as a signed-in user, and read the
// state of Telegram's native MainButton from the calls the fake WebApp recorded.

export const TEXT = { uz, ru } as const;
export type Lang = keyof typeof TEXT;
export const SCHEMES = ['light', 'dark'] as const;

export interface Open {
  lang?: Lang;
  scheme?: 'light' | 'dark';
  catalog?: CatalogApiOptions;
  product?: ProductApiOptions;
  /** Hold the slow answers until `release()`. */
  hold?: boolean;
}

export async function openProduct(
  page: Page,
  slug: string,
  { lang = 'uz', scheme = 'light', catalog, product, hold }: Open = {},
) {
  await installFakeWebApp(page, { initData: INIT_DATA, colorScheme: scheme, languageCode: lang });
  await installTgApi(page, [{ kind: 'ok', user: { locale: lang } }]);
  await installCatalogApi(page, catalog);
  const api = await installProductApi(page, product);
  if (hold) api.hold();
  await page.goto(`/tg/products/${slug}`);
  return api;
}

export interface MainButtonState {
  text: string | null;
  enabled: boolean | null;
  visible: boolean | null;
  progress: boolean;
}

/** The MainButton as Telegram would show it now: the last call of each kind wins. */
export async function mainButton(page: Page): Promise<MainButtonState> {
  const state: MainButtonState = { text: null, enabled: null, visible: null, progress: false };
  for (const [name, ...args] of await tgCalls(page)) {
    if (name === 'MainButton.setText') state.text = String(args[0]);
    else if (name === 'MainButton.enable') state.enabled = true;
    else if (name === 'MainButton.disable') state.enabled = false;
    else if (name === 'MainButton.show') state.visible = true;
    else if (name === 'MainButton.hide') state.visible = false;
    else if (name === 'MainButton.showProgress') state.progress = true;
    else if (name === 'MainButton.hideProgress') state.progress = false;
  }
  return state;
}

export const usernameField = (page: Page) => page.getByRole('textbox', { name: /username/i });

/** Types a username, looks it up and confirms the person that comes back. */
export async function confirmRecipient(page: Page, lang: Lang = 'uz', username = 'aziz_k') {
  const t = TEXT[lang].store.product.recipient;
  await usernameField(page).fill(username);
  await page.getByRole('button', { name: t.check, exact: true }).click();
  await page.getByRole('button', { name: t.confirm, exact: true }).click();
}

export async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}
