import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, type Page } from '@playwright/test';
import { settle } from '../support/settle';

// The product pages (phase 8 S3) under test: `/telegram-stars` and `/telegram-premium`, in Uzbek
// (no prefix) and Russian (`/ru`), with the texts they are expected to show read from the same
// catalogs the page uses.

export const PRODUCT_LANGS = {
  uz: { site: uz.site, catalog: uz.store.catalog, prefix: '', store: '/store', unit: 'so‘m' },
  ru: { site: ru.site, catalog: ru.store.catalog, prefix: '/ru', store: '/ru/store', unit: 'сум' },
} as const;
export type ProductLang = keyof typeof PRODUCT_LANGS;

export const PRODUCTS = [
  { slug: 'telegram-stars', key: 'stars', name: 'Telegram Stars' },
  { slug: 'telegram-premium', key: 'premium', name: 'Telegram Premium' },
] as const;
export type ProductSlug = (typeof PRODUCTS)[number]['slug'];
export type ProductKey = (typeof PRODUCTS)[number]['key'];

export const productPath = (slug: ProductSlug, lang: ProductLang) =>
  `${PRODUCT_LANGS[lang].prefix}/${slug}`;

/** The copy of a product page: its own block of `site.product` and the shared one. */
export const productCopy = (key: ProductKey, lang: ProductLang) => ({
  own: PRODUCT_LANGS[lang].site.product[key],
  common: PRODUCT_LANGS[lang].site.product.common,
});

/**
 * Opens a product page and waits until it is steady: the H1 is there, the package block has
 * replaced its placeholder (the catalog answered), fonts are in and the entrance animations are
 * over.
 */
export async function openProduct(page: Page, slug: ProductSlug, lang: ProductLang) {
  await page.goto(productPath(slug, lang));
  await page.getByRole('heading', { level: 1 }).waitFor();
  // Two placeholders can be up at once (the package block and the other products).
  await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(0);
  await settle(page);
}
