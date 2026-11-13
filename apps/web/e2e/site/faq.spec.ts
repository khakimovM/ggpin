import { expect, test } from '@playwright/test';
import { BRAND } from '@repo/shared';
import { overflow } from '../tg/support';
import { INFO_LANGS, infoPath, openInfo, SITE, type InfoLang } from './info-support';
import { jsonLdBlocks } from './landing-support';
import { seriousViolations } from './shell-support';

// The FAQ page of phase 8 S4 (P8-Q9): the landing's five questions and the help screen's six, each
// asked once (eight in all), as the landing's accordion with a trail above it, and the FAQPage
// structured data of the very same texts. The head's protocol checks are in info.http.spec.ts.

for (const lang of ['uz', 'ru'] as const satisfies InfoLang[]) {
  const { copy, prefix } = INFO_LANGS[lang];
  const landing = copy.site.faq.items;
  const help = copy.account.help.faq;
  // The order of the page (src/features/site/faq/faq-page.ts): the order, the money, the extras.
  const QUESTIONS = [
    landing.q1,
    landing.q2,
    landing.q3,
    landing.q4,
    help.q4,
    help.q6,
    landing.q5,
    help.q5,
  ];

  test.describe(`${lang}: the FAQ page`, () => {
    test.beforeEach(async ({ page }) => {
      await openInfo(page, 'faq', lang);
    });

    test('the title, the trail, eight questions with the first open, one at a time', async ({
      page,
    }) => {
      const main = page.getByRole('main');
      await expect(main.getByRole('heading', { level: 1 })).toHaveText(copy.site.meta.faq.title);
      await expect(main.getByText(copy.site.faq.lead)).toBeVisible();
      const trail = main.getByRole('navigation', {
        name: copy.site.product.common.breadcrumb.label,
      });
      await expect(trail.getByRole('link')).toHaveAttribute('href', prefix === '' ? '/' : prefix);

      const items = main.locator('details');
      await expect(items).toHaveCount(QUESTIONS.length);
      // Each question is an h2 in its summary, right under the page's h1.
      await expect(items.locator('summary').getByRole('heading', { level: 2 })).toHaveText(
        QUESTIONS,
      );
      await expect(items.nth(0)).toHaveAttribute('open', '');
      await expect(main.getByText(landing.a1)).toBeVisible();
      await expect(main.getByText(help.a4)).toBeHidden();

      await items.nth(4).locator('summary').click();
      await expect(main.getByText(help.a4)).toBeVisible();
      await expect(items.nth(0)).not.toHaveAttribute('open', '');

      // Keyboard: Enter on a focused question opens it and closes the one open before it.
      await items.nth(5).locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(main.getByText(help.a6.replace('{brand}', BRAND.name))).toBeVisible();
      await expect(items.nth(4)).not.toHaveAttribute('open', '');
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('no support link configured: no "write to support", the lead leads to the contacts', async ({
      page,
    }) => {
      // The e2e build has NEXT_PUBLIC_SUPPORT_URL empty (playwright.config.ts).
      const main = page.getByRole('main');
      await expect(main.getByRole('link', { name: copy.site.faq.support })).toHaveCount(0);
      const contacts = main.getByRole('link', { name: copy.site.footer.infoLinks.contacts });
      await expect(contacts).toHaveAttribute('href', `${prefix}/contacts`);
      await contacts.click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        copy.site.meta.contacts.title,
      );
    });

    test('structured data: the trail and FAQPage with the eight questions, under the nonce', async ({
      page,
    }) => {
      const blocks = await jsonLdBlocks(page);
      expect(blocks.map((block) => block.data['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
      const nonces = new Set(blocks.map((block) => block.nonce));
      expect(nonces.size).toBe(1);
      expect([...nonces][0]).not.toBe('');
      const [trail, faq] = blocks.map((block) => block.data);
      const steps = (trail?.itemListElement ?? []) as { name: string; item?: string }[];
      expect(steps.map((step) => step.name)).toEqual([
        copy.site.product.common.breadcrumb.home,
        copy.site.meta.faq.title,
      ]);
      expect(steps[1]?.item).toBe(`${SITE}${infoPath('faq', lang)}`);
      const entities = (faq?.mainEntity ?? []) as {
        name: string;
        acceptedAnswer: { text: string };
      }[];
      expect(entities.map((entity) => entity.name)).toEqual(QUESTIONS);
      expect(entities[0]?.acceptedAnswer.text).toBe(landing.a1);
      // The help answer that names the brand has it filled in, never the placeholder.
      expect(entities[5]?.acceptedAnswer.text).toBe(help.a6.replace('{brand}', BRAND.name));
      expect(JSON.stringify(blocks)).not.toContain('{brand}');
    });

    test('metadata: its own title and description, indexable, canonical', async ({ page }) => {
      await expect(page).toHaveTitle(`${copy.site.meta.faq.title} — ${BRAND.name}`);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        'content',
        copy.site.meta.faq.description,
      );
      await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${SITE}${infoPath('faq', lang)}`,
      );
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme}: axe finds nothing serious`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openInfo(page, 'faq', lang);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  });
}
