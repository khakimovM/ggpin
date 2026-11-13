import { expect, test } from '@playwright/test';
import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { BRAND } from '@repo/shared';
import { E2E_BOT_URL, E2E_CHANNEL_URL } from '../support/app-env';
import { overflow } from '../tg/support';
import { heroTitle, jsonLdBlocks, LANDING, openLanding, type LandingLang } from './landing-support';
import { seriousViolations } from './shell-support';

// The landing (phase 8 S2) against the fixture catalog: the sections and the anchors the header
// points at, the buttons and where they lead, the product tiles, the FAQ, the structured data and
// the metadata, in both languages. The API-down scenario has its own file (landing-degraded.spec.ts).

const SITE = 'http://localhost:3100';

// How a tile's price line reads: "11 000 so‘m dan boshlab" / "от 11 000 сум". The amounts are the
// fixture catalog's (1100000 tiyin = 11 000 so'm, the cheapest Stars package; 16500000 tiyin =
// 165 000 so'm, the cheapest Premium plan).
const PRICE_LINE: Record<LandingLang, (amount: string) => RegExp> = {
  uz: (amount) => new RegExp(`${amount}\\s${uz.common.currency.uzs}\\sdan\\sboshlab`),
  ru: (amount) => new RegExp(`от\\s${amount}\\s${ru.common.currency.uzs}`),
};

for (const lang of ['uz', 'ru'] as const satisfies LandingLang[]) {
  const { copy, catalog, path, store } = LANDING[lang];
  const prefix = lang === 'uz' ? '' : '/ru';
  const unit = lang === 'uz' ? uz.common.currency.uzs : ru.common.currency.uzs;

  test.describe(`${lang}: the landing`, () => {
    test.beforeEach(async ({ page }) => {
      await openLanding(page, lang);
    });

    test('the page, in order: hero, products, how it works, why us, FAQ, final call', async ({
      page,
    }) => {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heroTitle(lang));
      expect(await page.getByRole('heading', { level: 2 }).allTextContents()).toEqual([
        copy.products.title,
        copy.how.title,
        copy.why.title,
        copy.faq.title,
        copy.cta.title,
      ]);
      // The referral band stays out until the percentage is decided (phase 10).
      await expect(page.getByText(/1\s?%/)).toHaveCount(0);
    });

    test('the nav anchors point at real sections', async ({ page }) => {
      for (const id of ['products', 'how-it-works', 'faq']) {
        await expect(page.locator(`main section#${id}`)).toHaveCount(1);
      }
      // The header (and, on a narrow screen, its menu) link to the sections of THIS page.
      const hrefs = await page
        .locator('header a[href*="#"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
      expect(new Set(hrefs)).toEqual(
        new Set(['products', 'how-it-works', 'faq'].map((id) => `${path}#${id}`)),
      );
    });

    test('a section link scrolls to its section and leaves its heading below the header', async ({
      page,
    }) => {
      const wide = await page.getByRole('navigation', { name: copy.nav.main }).isVisible();
      if (!wide) await page.getByRole('button', { name: copy.nav.menu }).click();
      const nav = page.getByRole('navigation', {
        name: wide ? copy.nav.main : copy.nav.menu,
      });
      await nav.getByRole('link', { name: copy.nav.faq }).click();
      await expect(page).toHaveURL(/#faq$/);
      const heading = page.getByRole('heading', { level: 2, name: copy.faq.title });
      await expect(heading).toBeInViewport();
      const [headingTop, headerBottom] = await Promise.all([
        heading.evaluate((element) => element.getBoundingClientRect().top),
        page.getByRole('banner').evaluate((element) => element.getBoundingClientRect().bottom),
      ]);
      expect(headingTop).toBeGreaterThanOrEqual(headerBottom);
    });

    test('the buttons lead where they say, and the outside ones open safely', async ({ page }) => {
      const main = page.getByRole('main');
      const telegram = main.getByRole('link', { name: copy.cta.telegram });
      await expect(telegram).toHaveCount(2); // the hero and the final call
      for (const link of await telegram.all()) {
        await expect(link).toHaveAttribute('href', E2E_BOT_URL);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      }
      const shop = main.getByRole('link', { name: copy.cta.store });
      await expect(shop).toHaveCount(2);
      for (const link of await shop.all()) await expect(link).toHaveAttribute('href', store);
      await expect(main.getByRole('link', { name: copy.products.all })).toHaveAttribute(
        'href',
        store,
      );
      // The design's own handles are nowhere on the page (the bot comes from the environment).
      const html = await page.content();
      expect(html).not.toContain('ggpinbot');
      expect(html).not.toContain('ggpin_support');
    });

    test('the product tiles: live ones with the server price, the rest without one', async ({
      page,
    }) => {
      const products = page.locator('#products');
      const stars = products.getByRole('link', { name: /Telegram Stars/ });
      // Stars and Premium have a page of their own (phase 8 S3); the other tiles lead into the store.
      await expect(stars).toHaveAttribute('href', `${prefix}/telegram-stars`);
      await expect(stars).toContainText(PRICE_LINE[lang]('11\\s000'));
      const premium = products.getByRole('link', { name: /Telegram Premium/ });
      await expect(premium).toContainText(PRICE_LINE[lang]('165\\s000'));
      await expect(premium).toHaveAttribute('href', `${prefix}/telegram-premium`);
      // A product with no fresh price shows none, and its sold-out chip says why it is idle.
      const freeFire = products.getByRole('link', { name: /Free Fire/ });
      await expect(freeFire).toContainText(catalog.soldOut);
      await expect(freeFire).not.toContainText(unit);
      // The API serves the four announced games, so none of them is announced as "soon".
      await expect(products.getByText(copy.products.soon, { exact: true })).toHaveCount(0);
      const hrefs = await products
        .locator('ul a')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
      expect(hrefs.length).toBeGreaterThanOrEqual(2);
      for (const href of hrefs) {
        expect(href).toMatch(/\/(?:store\/products\/[a-z0-9-]+|telegram-(?:stars|premium))$/);
      }
    });

    test('the FAQ: the first answer is open, one at a time, and the keyboard works', async ({
      page,
    }) => {
      const items = page.locator('#faq details');
      await expect(items).toHaveCount(5);
      await expect(items.nth(0)).toHaveAttribute('open', '');
      await expect(items.nth(1)).not.toHaveAttribute('open', '');
      await expect(page.getByText(copy.faq.items.a1)).toBeVisible();
      await expect(page.getByText(copy.faq.items.a2)).toBeHidden();

      await items.nth(1).locator('summary').click();
      await expect(page.getByText(copy.faq.items.a2)).toBeVisible();
      await expect(items.nth(0)).not.toHaveAttribute('open', '');

      // Keyboard: a focused summary opens with Enter, and the one open before it closes.
      await items.nth(2).locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText(copy.faq.items.a3)).toBeVisible();
      await expect(items.nth(1)).not.toHaveAttribute('open', '');
    });

    test('structured data: Organization, WebSite and FAQPage (no Product), with the nonce', async ({
      page,
    }) => {
      const blocks = await jsonLdBlocks(page);
      expect(blocks.map((block) => block.data['@type'])).toEqual([
        'Organization',
        'WebSite',
        'FAQPage',
      ]);
      const nonces = new Set(blocks.map((block) => block.nonce));
      expect(nonces.size).toBe(1);
      expect([...nonces][0]).not.toBe('');
      const [organization, website, faq] = blocks.map((block) => block.data);
      expect(organization?.name).toBe(BRAND.name);
      // No logo asset exists yet, so the field is absent rather than a dead URL.
      expect(organization).not.toHaveProperty('logo');
      expect(organization?.sameAs).toEqual([E2E_BOT_URL, E2E_CHANNEL_URL]);
      expect(website?.inLanguage).toBe(lang);
      const entities = (faq?.mainEntity ?? []) as {
        name: string;
        acceptedAnswer: { text: string };
      }[];
      expect(entities.map((entity) => entity.name)).toEqual([
        copy.faq.items.q1,
        copy.faq.items.q2,
        copy.faq.items.q3,
        copy.faq.items.q4,
        copy.faq.items.q5,
      ]);
      expect(entities[0]?.acceptedAnswer.text).toBe(copy.faq.items.a1);
      expect(JSON.stringify(blocks)).not.toMatch(/"Product"|"Offer"|"price"/);
    });

    test('metadata: title, description, canonical and the language pair', async ({ page }) => {
      const title = copy.meta.home.title.replace('{brand}', BRAND.name);
      await expect(page).toHaveTitle(title);
      const description = await page.locator('meta[name="description"]').getAttribute('content');
      expect(description).toBe(copy.meta.home.description);
      expect(description?.length ?? 0).toBeGreaterThan(50);
      expect(description?.length ?? 0).toBeLessThanOrEqual(170);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        lang === 'uz' ? SITE : `${SITE}/ru`,
      );
      await expect(page.locator('link[rel="alternate"][hreflang="uz"]')).toHaveAttribute(
        'href',
        SITE,
      );
      await expect(page.locator('link[rel="alternate"][hreflang="ru"]')).toHaveAttribute(
        'href',
        `${SITE}/ru`,
      );
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', title);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
    });

    test('nothing of the design sample is on the page', async ({ page }) => {
      const text = (await page.locator('body').innerText()).toLowerCase();
      // The sample people and prices of the design, and the payment methods of the old Russian hero.
      for (const sample of ['dilnoza', 'sardor', '120 750', 'click', 'payme']) {
        expect(text, sample).not.toContain(sample);
      }
    });

    test('the hero picture is decorative: hidden from assistive technology', async ({ page }) => {
      const hero = page.locator('section[aria-labelledby="hero-title"]');
      await expect(hero.locator('> div > div[aria-hidden="true"]')).toHaveCount(1);
      for (const text of [copy.hero.mock.delivered, copy.hero.mock.premium]) {
        const card = hero.getByText(text);
        await expect(card).toHaveCount(1);
        expect(
          await card.evaluate((element) => element.closest('[aria-hidden="true"]')),
        ).not.toBeNull();
      }
    });

    test('nothing sticks out sideways, and axe finds nothing serious', async ({ page }) => {
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await seriousViolations(page)).toEqual([]);
    });
  });

  test.describe(`${lang}: the landing, themes and motion`, () => {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme}: axe finds nothing serious, with another answer open`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openLanding(page, lang);
        await page.locator('#faq details').nth(3).locator('summary').click();
        await expect(page.getByText(copy.faq.items.a4)).toBeVisible();
        expect(await seriousViolations(page)).toEqual([]);
      });
    }

    test('reduced motion: nothing on the page is animated, and the cards are simply there', async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openLanding(page, lang);
      const running = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === 'running')
          .map((animation) =>
            animation instanceof CSSAnimation ? animation.animationName : 'animation',
          ),
      );
      expect(running).toEqual([]);
      await expect(page.getByText(copy.hero.mock.delivered)).toBeVisible();
    });
  });
}
