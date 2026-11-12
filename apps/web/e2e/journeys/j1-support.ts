import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, type Page } from '@playwright/test';

// Shared parts of journey 1 (web sign-in): the texts of each language and the two ways of getting
// to the sign-in page. Kept out of the spec so that the spec stays under the 300 line limit.

export const CATALOGS = {
  uz: {
    text: uz.web,
    path: '/login',
    store: '/store',
    home: '/',
    nav: uz.site.nav,
    hero: uz.site.hero.title,
  },
  ru: {
    text: ru.web,
    path: '/ru/login',
    store: '/ru/store',
    home: '/ru',
    nav: ru.site.nav,
    hero: ru.site.hero.title,
  },
} as const;
export type Lang = keyof typeof CATALOGS;

export async function openLogin(page: Page, lang: Lang, theme: 'light' | 'dark', query = '') {
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), theme);
  await page.goto(`${CATALOGS[lang].path}${query}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
}

// The journey starts where a visitor does: on the landing, with the header's sign-in link (it sits
// in the header from 1041 px, and beside the menu button below that: one of the two is visible).
export async function startFromLanding(page: Page, lang: Lang, theme: 'light' | 'dark') {
  const { home, hero, nav, path } = CATALOGS[lang];
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), theme);
  await page.goto(home);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(hero);
  await page
    .getByRole('banner')
    .getByRole('link', { name: nav.login })
    .locator('visible=true')
    .click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15_000 });
}
