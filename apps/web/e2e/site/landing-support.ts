import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Page } from '@playwright/test';
import { settle } from '../support/settle';

// The landing (phase 8 S2) under test: `/` in Uzbek and `/ru` in Russian, with the texts they are
// expected to show read from the same catalogs the page uses.

export const LANDING = {
  uz: { copy: uz.site, catalog: uz.store.catalog, path: '/', store: '/store' },
  ru: { copy: ru.site, catalog: ru.store.catalog, path: '/ru', store: '/ru/store' },
} as const;
export type LandingLang = keyof typeof LANDING;

/** The H1 as the page writes it: the sentence and its accent, one space apart. */
export const heroTitle = (lang: LandingLang) =>
  `${LANDING[lang].copy.hero.title} ${LANDING[lang].copy.hero.titleAccent}`;

/**
 * Opens the landing and waits until it is steady: fonts are in, and the entrance animations of the
 * hero's floating cards are over (the contrast check and a screenshot must not read a frame in
 * which a card is half transparent). The cards bob for good, which is not waited for.
 */
export async function openLanding(page: Page, lang: LandingLang) {
  await page.goto(LANDING[lang].path);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await settle(page);
}

/** The parsed `<script type="application/ld+json">` blocks of the page, with their nonce. */
export async function jsonLdBlocks(page: Page) {
  return page.locator('script[type="application/ld+json"]').evaluateAll((scripts) =>
    scripts.map((script) => ({
      // Browsers blank the nonce ATTRIBUTE once the page has loaded; the property keeps it.
      nonce: script.nonce,
      data: JSON.parse(script.textContent ?? 'null') as Record<string, unknown>,
    })),
  );
}
