import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Page } from '@playwright/test';
import { settle } from '../support/settle';

// The information pages of phase 8 S4 under test: the FAQ, the contacts and the two legal texts
// (drafts until the lawyer's text, D-16), in Uzbek (no prefix) and Russian (`/ru`), with the texts
// they are expected to show read from the same catalogs the pages use.

export const SITE = 'http://localhost:3100';

export const INFO_LANGS = {
  uz: { copy: uz, prefix: '' },
  ru: { copy: ru, prefix: '/ru' },
} as const;
export type InfoLang = keyof typeof INFO_LANGS;

export const INFO_PAGES = ['faq', 'contacts', 'terms', 'privacy'] as const;
export type InfoPage = (typeof INFO_PAGES)[number];
export const LEGAL_PAGES = ['terms', 'privacy'] as const;

export const infoPath = (which: InfoPage, lang: InfoLang) => `${INFO_LANGS[lang].prefix}/${which}`;

/** Opens an information page and waits until it is steady: the H1 is there, fonts are in. */
export async function openInfo(page: Page, which: InfoPage, lang: InfoLang) {
  await page.goto(infoPath(which, lang));
  await page.getByRole('heading', { level: 1 }).waitFor();
  await settle(page);
}
