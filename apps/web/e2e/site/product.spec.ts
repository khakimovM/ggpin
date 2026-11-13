import { expect, test } from '@playwright/test';
import { BRAND } from '@repo/shared';
import { E2E_BOT_URL } from '../support/app-env';
import { overflow } from '../tg/support';
import { jsonLdBlocks } from './landing-support';
import {
  openProduct,
  PRODUCT_LANGS,
  PRODUCTS,
  productCopy,
  productPath,
  type ProductLang,
} from './product-support';
import { seriousViolations } from './shell-support';

// The product pages (phase 8 S3) against the fixture catalog: both products, both languages. The
// states with a thin or a broken catalog are in product-states.spec.ts.

const SITE = 'http://localhost:3100';

// What the fixture catalog holds (e2e/support/catalog-server-data.ts): Stars cost 220 so'm each,
// Premium 3 months 165 000 so'm.
const FIRST_PRICE = { 'telegram-stars': '11\\s000', 'telegram-premium': '165\\s000' } as const;

for (const lang of ['uz', 'ru'] as const satisfies ProductLang[]) {
  const { site, prefix, store, unit } = PRODUCT_LANGS[lang];

  for (const { slug, key, name } of PRODUCTS) {
    const { own, common } = productCopy(key, lang);
    const url = `${SITE}${productPath(slug, lang)}`;
    const buyName = new RegExp(`^${common.buy.label}`);

    test.describe(`${lang}: ${slug}`, () => {
      test.beforeEach(async ({ page }) => {
        await openProduct(page, slug, lang);
      });

      test('the page: one H1, the sections in order, and nothing sticks out sideways', async ({
        page,
      }) => {
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
        expect(await page.getByRole('heading', { level: 2 }).allTextContents()).toEqual([
          own.how.title,
          own.faq.title,
          common.related.title,
        ]);
        await expect(page.getByText(own.lead)).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      });

      test("the response is 200 and the metadata is the page's own, in <head>", async ({
        page,
        request,
      }) => {
        const response = await request.get(productPath(slug, lang));
        expect(response.status()).toBe(200);
        await expect(page).toHaveTitle(`${own.meta.title} — ${BRAND.name}`);
        await expect(page.locator('meta[name="description"]')).toHaveAttribute(
          'content',
          own.meta.description,
        );
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
          'content',
          `${own.meta.title} — ${BRAND.name}`,
        );
      });

      test('canonical is the page itself and the hreflang pair is full and two-way', async ({
        page,
      }) => {
        const alternates = {
          uz: `${SITE}/${slug}`,
          ru: `${SITE}/ru/${slug}`,
          'x-default': `${SITE}/${slug}`,
        };
        const expectPair = async () => {
          for (const [hreflang, href] of Object.entries(alternates)) {
            await expect(
              page.locator(`link[rel="alternate"][hreflang="${hreflang}"]`),
            ).toHaveAttribute('href', href);
          }
        };
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', url);
        await expectPair();
        // The other language version says the same about the pair, and names itself canonical.
        const otherUrl = lang === 'uz' ? alternates.ru : alternates.uz;
        await page.goto(otherUrl);
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', otherUrl);
        await expectPair();
      });

      test('the buttons lead where they say, and the outside one opens safely', async ({
        page,
      }) => {
        const main = page.getByRole('main');
        const buy = main.getByRole('link', { name: buyName });
        await expect(buy).toHaveCount(1);
        await expect(buy).toHaveAttribute('href', `${store}/products/${slug}`);
        const bot = main.getByRole('link', { name: common.telegram });
        await expect(bot).toHaveAttribute('href', E2E_BOT_URL);
        await expect(bot).toHaveAttribute('target', '_blank');
        await expect(bot).toHaveAttribute('rel', 'noopener noreferrer');
        const html = await page.content();
        expect(html).not.toContain('ggpinbot');
        expect(html).not.toContain('/katalog');
      });

      test('the package list: server prices, a radiogroup, the arrows and the buy button follow', async ({
        page,
      }) => {
        const rows = page.getByRole('radiogroup', { name: own.packages.label }).getByRole('radio');
        await expect(rows.first()).toHaveAttribute('aria-checked', 'true');
        await expect(rows.first()).toContainText(new RegExp(`${FIRST_PRICE[slug]}\\s${unit}`));
        const buy = page.getByRole('main').getByRole('link', { name: buyName });
        await expect(buy).toContainText(new RegExp(`${common.buy.label} · ${FIRST_PRICE[slug]}`));

        // The arrows choose and move the focus.
        await rows.first().focus();
        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(1)).toHaveAttribute('aria-checked', 'true');
        await expect(rows.nth(1)).toBeFocused();
        await expect(buy).not.toContainText(new RegExp(FIRST_PRICE[slug]));
        await page.keyboard.press('End');
        await expect(rows.last()).toHaveAttribute('aria-checked', 'true');
        await page.keyboard.press('Home');
        await expect(rows.first()).toHaveAttribute('aria-checked', 'true');
        // The package is not carried to the store (the store asks again): the link stays the same.
        await expect(buy).toHaveAttribute('href', `${store}/products/${slug}`);
      });

      test('Tab passes the group in one stop', async ({ page }) => {
        await page.getByRole('radiogroup').getByRole('radio').first().focus();
        await page.keyboard.press('Tab');
        // The next stop is the buy button, not the second package.
        await expect(page.getByRole('main').getByRole('link', { name: buyName })).toBeFocused();
      });

      test('structured data: BreadcrumbList and FAQPage with the nonce, no Product', async ({
        page,
      }) => {
        const blocks = await jsonLdBlocks(page);
        expect(blocks.map((block) => block.data['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
        expect(new Set(blocks.map((block) => block.nonce)).size).toBe(1);
        const [trail, faq] = blocks.map((block) => block.data);
        const items = (trail?.itemListElement ?? []) as { name: string; item: string }[];
        // Two items: the visible "Mahsulotlar" step is a fragment (/#products), not a page.
        expect(items.map((item) => item.name)).toEqual([common.breadcrumb.home, name]);
        expect(items[0]?.item).toBe(lang === 'uz' ? SITE : `${SITE}/ru`);
        expect(items[1]?.item).toBe(url);
        const questions = (faq?.mainEntity ?? []) as { name: string }[];
        expect(questions.map((question) => question.name)).toEqual([
          own.faq.items.q1,
          own.faq.items.q2,
          own.faq.items.q3,
          own.faq.items.q4,
        ]);
        expect(JSON.stringify(blocks)).not.toMatch(/"Product"|"Offer"|"price"/);
      });

      test('the FAQ: the first answer is open, one at a time', async ({ page }) => {
        const items = page.locator('main details');
        await expect(items).toHaveCount(4);
        await expect(items.nth(0)).toHaveAttribute('open', '');
        await items.nth(1).locator('summary').click();
        await expect(items.nth(1)).toHaveAttribute('open', '');
        await expect(items.nth(0)).not.toHaveAttribute('open', '');
      });

      test('the other products: the other SEO page and the store, never this page', async ({
        page,
      }) => {
        const related = page
          .getByRole('heading', { level: 2, name: common.related.title })
          .locator('xpath=ancestor::section[1]');
        const hrefs = await related
          .locator('a')
          .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
        expect(hrefs).not.toContain(`${prefix}/${slug}`);
        const other = slug === 'telegram-stars' ? 'telegram-premium' : 'telegram-stars';
        expect(hrefs).toContain(`${prefix}/${other}`);
        expect(hrefs.length).toBeLessThanOrEqual(4);
      });

      test('the breadcrumb leads home and to the products block', async ({ page }) => {
        const nav = page.getByRole('navigation', { name: common.breadcrumb.label });
        const home = lang === 'uz' ? '/' : '/ru';
        await expect(nav.getByRole('link', { name: common.breadcrumb.home })).toHaveAttribute(
          'href',
          home,
        );
        await expect(nav.getByRole('link', { name: common.breadcrumb.products })).toHaveAttribute(
          'href',
          `${home}#products`,
        );
        await expect(nav.getByText(name)).toHaveAttribute('aria-current', 'page');
      });

      for (const scheme of ['light', 'dark'] as const) {
        test(`${scheme}: axe finds nothing serious, with another package chosen`, async ({
          page,
        }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await openProduct(page, slug, lang);
          await page.getByRole('radiogroup').getByRole('radio').nth(1).click();
          await page.locator('main details').nth(2).locator('summary').click();
          expect(await seriousViolations(page)).toEqual([]);
        });
      }
    });
  }

  test.describe(`${lang}: the site around the product pages`, () => {
    test('the footer lists both product pages and they answer', async ({ page, request }) => {
      await page.goto(lang === 'uz' ? '/' : '/ru');
      const footer = page.getByRole('contentinfo');
      for (const { slug, key } of PRODUCTS) {
        const link = footer.getByRole('link', { name: site.footer.productLinks[key] });
        await expect(link).toHaveAttribute('href', `${prefix}/${slug}`);
        expect((await request.get(`${prefix}/${slug}`)).status()).toBe(200);
      }
    });

    test('the language switch keeps the product page', async ({ page }) => {
      await page.goto(productPath('telegram-stars', lang));
      const target = lang === 'uz' ? 'ru' : 'uz';
      // The footer's switch is on screen at every width (the header's folds into the menu).
      const group = page.getByRole('contentinfo').getByRole('group', { name: site.nav.language });
      await group.locator(`a[hreflang="${target}"]`).click();
      await expect(page).toHaveURL(`${SITE}${productPath('telegram-stars', target)}`);
    });

    test('a ?utm_ copy of a product page names the clean URL as its canonical', async ({
      page,
    }) => {
      await page.goto(`${productPath('telegram-stars', lang)}?utm_source=telegram`);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${SITE}${productPath('telegram-stars', lang)}`,
      );
    });
  });
}

test.describe("the price in a package is the server's string", () => {
  test('uz: the figures of the fixture, grouped the way the store groups them', async ({
    page,
  }) => {
    await openProduct(page, 'telegram-stars', 'uz');
    const rows = page.getByRole('radiogroup').getByRole('radio');
    const texts = (await rows.allTextContents()).map((text) => text.replace(/\s/g, ' '));
    expect(texts).toEqual([
      '50 ⭐11 000 so‘m',
      '100 ⭐22 000 so‘m',
      '250 ⭐55 000 so‘m',
      '500 ⭐110 000 so‘m',
      '1000 ⭐220 000 so‘m',
      '2500 ⭐550 000 so‘m',
    ]);
    // The card says what a star costs, from the API's display price.
    await expect(page.getByRole('main').locator('dl')).toContainText(/1 ⭐ = 220\s+so‘m/);
  });
});
