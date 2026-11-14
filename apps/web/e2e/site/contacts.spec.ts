import { expect, test, type Page } from '@playwright/test';
import { BRAND } from '@repo/shared';
import { E2E_BOT_URL, E2E_BOT_USERNAME, E2E_CHANNEL_URL } from '../support/app-env';
import { overflow } from '../tg/support';
import { INFO_LANGS, infoPath, openInfo, SITE, type InfoLang } from './info-support';
import { jsonLdBlocks } from './landing-support';
import { seriousViolations } from './shell-support';

// The contacts page of phase 8 S4 (P8-Q10): a card per way to reach us that is configured, and the
// operators' hours. The e2e build configures the bot and the channel but no support chat
// (playwright.config.ts), so the support card must not be there. No company details (D-57).

const WIDTHS = [360, 390, 768, 1024, 1440];

/** Whether the hours' range ("09:00–23:00", joined by U+2060) is ever split over two lines. */
function hoursSplit(page: Page) {
  return page.evaluate(() => {
    const joined = '09:00\u2060\u2013\u206023:00';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(joined);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + joined.length);
      const tops = [...range.getClientRects()].map((rect) => rect.top);
      return { found: true, split: Math.max(...tops) - Math.min(...tops) > 8 };
    }
    return { found: false, split: false };
  });
}

for (const lang of ['uz', 'ru'] as const satisfies InfoLang[]) {
  const { copy, prefix } = INFO_LANGS[lang];
  const t = copy.site.contacts;

  test.describe(`${lang}: the contacts page`, () => {
    test.beforeEach(async ({ page }) => {
      await openInfo(page, 'contacts', lang);
    });

    test('the title, the trail, and the bot, the channel and the hours (no support chat)', async ({
      page,
    }) => {
      const main = page.getByRole('main');
      await expect(main.getByRole('heading', { level: 1 })).toHaveText(
        copy.site.meta.contacts.title,
      );
      await expect(main.getByText(copy.site.why.items.support.text)).toBeVisible();
      const trail = main.getByRole('navigation', {
        name: copy.site.product.common.breadcrumb.label,
      });
      await expect(trail.getByRole('link')).toHaveAttribute('href', prefix === '' ? '/' : prefix);

      const cards = main.locator('ul > li');
      await expect(cards.getByRole('heading', { level: 2 })).toHaveText([
        t.bot.title,
        t.channel.title,
        t.hours.title,
      ]);
      await expect(main.getByRole('heading', { name: t.support.title })).toHaveCount(0);
      await expect(cards.nth(0)).toContainText(`@${E2E_BOT_USERNAME}`);
      await expect(cards.nth(1)).toContainText(`@${new URL(E2E_CHANNEL_URL).pathname.slice(1)}`);
      await expect(cards.nth(2)).toContainText(copy.account.help.ask.hours);
      await expect(cards.nth(2).getByRole('link')).toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('each link leaves the site in a new tab, without an opener', async ({ page }) => {
      const main = page.getByRole('main');
      for (const [name, href] of [
        [t.bot.cta, E2E_BOT_URL],
        [t.channel.cta, E2E_CHANNEL_URL],
      ] as const) {
        const link = main.getByRole('link', { name });
        await expect(link).toHaveAttribute('href', href);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      }
      await expect(main.getByRole('link', { name: t.support.cta })).toHaveCount(0);
    });

    test('no company details: no tax number, no account, no phone', async ({ page }) => {
      const text = (await page.getByRole('main').textContent()) ?? '';
      expect(text).not.toMatch(/\bSTIR\b|\bINN\b|\bИНН\b|\+998|\d{9,}/);
    });

    test('the hours ("09:00–23:00") are never split over two lines', async ({ page }) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        expect(await hoursSplit(page), `@${width}px`).toEqual({ found: true, split: false });
        expect(await overflow(page), `@${width}px`).toBeLessThanOrEqual(0);
      }
    });

    test('metadata and structured data: indexable, canonical, the trail only', async ({ page }) => {
      await expect(page).toHaveTitle(`${copy.site.meta.contacts.title} — ${BRAND.name}`);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        'content',
        copy.site.meta.contacts.description,
      );
      await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${SITE}${infoPath('contacts', lang)}`,
      );
      const blocks = await jsonLdBlocks(page);
      expect(blocks.map((block) => block.data['@type'])).toEqual(['BreadcrumbList']);
      expect(blocks[0]?.nonce).not.toBe('');
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme}: axe finds nothing serious`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openInfo(page, 'contacts', lang);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  });
}
