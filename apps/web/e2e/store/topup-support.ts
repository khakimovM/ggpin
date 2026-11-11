import { expect, type Page } from '@playwright/test';
import { installPaymentsApi, type PaymentsApiOptions } from '../fixtures/payments';
import { TEXT, openStore, type Lang } from './catalog-support';

// Shared by the web top-up modal specs (phase 7 S8): the store opened, the modal opened over it.

export const t = (lang: Lang) => TEXT[lang].store.topup;
export const pay = (lang: Lang) => TEXT[lang].pay;
export const modal = (page: Page, lang: Lang = 'uz') =>
  page.getByRole('dialog', { name: t(lang).title });
export const plus = (page: Page, lang: Lang = 'uz') =>
  page.getByRole('button', { name: TEXT[lang].web.nav.topUp });
export const field = (page: Page, lang: Lang = 'uz') =>
  modal(page, lang).getByRole('textbox', { name: t(lang).amount.label });

export async function openModal(
  page: Page,
  lang: Lang = 'uz',
  payments?: PaymentsApiOptions,
  scheme: 'light' | 'dark' = 'light',
) {
  await openStore(page, { lang, scheme });
  // After the store's own fakes: the later route is asked first, and it only claims /payments.
  const api = await installPaymentsApi(page, payments);
  await plus(page, lang).click();
  await expect(modal(page, lang)).toBeVisible();
  return api;
}
