import { expect, test } from '@playwright/test';
import { E2E_DEGRADED_SITE_URL } from '../support/app-env';
import { heroTitle, LANDING, openLanding, type LandingLang } from './landing-support';
import { seriousViolations } from './shell-support';

// The landing when the catalog API is down (phase 8 S2, P8-Q20): the page is the same healthy
// document, only the products come without prices. These specs run against the degraded pair of
// servers (a catalog that always answers 500, and a site server that reads it); the site keeps a
// catalog answer for 60 s, so the main pair cannot be broken part-way through a run.

test.use({ baseURL: E2E_DEGRADED_SITE_URL });

for (const lang of ['uz', 'ru'] as const satisfies LandingLang[]) {
  const { copy, path, store } = LANDING[lang];
  const prefix = lang === 'uz' ? '' : '/ru';
  const unit = lang === 'uz' ? 'so‘m' : 'сум';

  test.describe(`${lang}: the landing with the API down`, () => {
    test('answers 200 with the whole page, and the products without prices', async ({
      page,
      request,
    }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      await openLanding(page, lang);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heroTitle(lang));
      for (const heading of [copy.how.title, copy.why.title, copy.faq.title, copy.cta.title]) {
        await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
      }

      const products = page.locator('#products');
      await expect(products.locator('ul[data-state="unavailable"]')).toBeVisible();
      // Stars and Premium stay, and still lead to their pages; no price anywhere in the block.
      await expect(products.getByRole('link', { name: copy.products.names.stars })).toHaveAttribute(
        'href',
        `${prefix}/telegram-stars`,
      );
      await expect(
        products.getByRole('link', { name: copy.products.names.premium }),
      ).toHaveAttribute('href', `${prefix}/telegram-premium`);
      await expect(products).not.toContainText(unit);
    });

    test('the announced games are named, with no link and no price', async ({ page }) => {
      await openLanding(page, lang);
      const products = page.locator('#products');
      await expect(products.getByText(copy.products.soon, { exact: true })).toHaveCount(4);
      await expect(products.getByText(copy.products.soonNote)).toHaveCount(4);
      // Two links only: Stars and Premium.
      await expect(products.locator('ul a')).toHaveCount(2);
    });

    test('no error banner and no retry button: a visitor still reaches the store', async ({
      page,
    }) => {
      await openLanding(page, lang);
      // (Next's own route announcer is an alert too, outside <main>: only the page's content counts.)
      await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
      await expect(
        page.getByRole('main').getByRole('link', { name: copy.cta.store }).first(),
      ).toHaveAttribute('href', store);
    });

    test('the structured data and the metadata do not depend on the API', async ({ page }) => {
      await openLanding(page, lang);
      const types = await page
        .locator('script[type="application/ld+json"]')
        .evaluateAll((scripts) =>
          scripts.map(
            (script) => (JSON.parse(script.textContent ?? '{}') as { '@type': string })['@type'],
          ),
        );
      expect(types).toEqual(['Organization', 'WebSite']);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        'content',
        copy.meta.home.description,
      );
    });

    test('axe finds nothing serious', async ({ page }) => {
      await openLanding(page, lang);
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}
