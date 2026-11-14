import { expect, test } from '@playwright/test';
import { E2E_BOT_URL, E2E_CHANNEL_URL } from '../support/app-env';
import { overflow } from '../tg/support';
import {
  brand,
  focusedName,
  headerRight,
  langName,
  LANGS,
  open,
  seriousViolations,
  type Lang,
} from './shell-support';

// The site shell (phase 8 S1): header, mobile menu, footer and language switch on the marketing
// home (`/`, `/ru`). The error page has its own file (shell-error.spec.ts).

for (const lang of ['uz', 'ru'] as const) {
  const { copy, path, wide, menu } = LANGS[lang];

  test.describe(`${lang}: the navigation collapses into the menu`, () => {
    test(`${wide} px shows the navigation, ${menu} px shows the menu`, async ({ page }) => {
      await open(page, path, wide);
      const nav = page.getByRole('navigation', { name: copy.nav.main });
      await expect(nav).toBeVisible();
      await expect(page.getByRole('button', { name: copy.nav.menu })).toBeHidden();
      await expect(
        page.getByRole('banner').getByRole('link', { name: copy.nav.openTelegram }),
      ).toBeVisible();
      // Everything fits: nothing is pushed past the edge at the widest-text boundary.
      const { right, viewport } = await headerRight(page);
      expect(right).toBeLessThanOrEqual(viewport);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.setViewportSize({ width: menu, height: 900 });
      await expect(nav).toBeHidden();
      await expect(page.getByRole('button', { name: copy.nav.menu })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}

for (const lang of ['uz', 'ru'] as const) {
  const { copy, path, other } = LANGS[lang];

  test.describe(`${lang}: header and footer`, () => {
    test('the logo leads home, "Open in Telegram" and the channel are external and safe', async ({
      page,
    }) => {
      await open(page, path, 1440);
      await expect(
        page.getByRole('link', { name: copy.nav.home.replace('{brand}', brand) }),
      ).toHaveAttribute('href', path);
      const telegram = page.getByRole('banner').getByRole('link', {
        name: copy.nav.openTelegram,
      });
      await expect(telegram).toHaveAttribute('href', E2E_BOT_URL);
      await expect(telegram).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(telegram).toHaveAttribute('target', '_blank');
      const footer = page.getByRole('contentinfo');
      await expect(footer.getByRole('link', { name: copy.footer.channel })).toHaveAttribute(
        'href',
        E2E_CHANNEL_URL,
      );
      // Every link that leaves the site opens safely.
      const external = await page.locator('a[href^="http"]').evaluateAll((links) =>
        links.map((link) => ({
          href: link.getAttribute('href'),
          rel: link.getAttribute('rel'),
        })),
      );
      expect(external.length).toBeGreaterThanOrEqual(3);
      for (const link of external) expect(link.rel).toBe('noopener noreferrer');
    });

    test('the handles come from configuration: the design sample is nowhere on the page', async ({
      page,
    }) => {
      await open(page, path, 1440);
      const html = await page.content();
      // The design file writes the bot as ggpinbot and the channel as t.me/ggpin; ours are the
      // configured ones (E2E_BOT_URL, E2E_CHANNEL_URL).
      expect(html).not.toContain('ggpinbot');
      expect(html).not.toContain('https://t.me/ggpin"');
      await expect(page.getByRole('contentinfo').getByRole('link', { name: /^@/ })).toHaveText(
        E2E_BOT_URL.replace('https://t.me/', '@'),
      );
    });

    test('the header and the footer link only to pages that exist', async ({ page }) => {
      // Each target is a server render of its own (the landing waits for the catalog): on a loaded
      // machine a dozen of them come close to the default 30 s of a test.
      test.slow();
      await open(page, path, 1440);
      const hrefs = await page
        .locator('header a[href^="/"], footer a[href^="/"]')
        .evaluateAll((a) => a.map((link) => link.getAttribute('href') ?? ''));
      const targets = new Set(hrefs.map((href) => href.split('#')[0] || '/'));
      expect(targets.size).toBeGreaterThan(3);
      for (const target of targets) {
        const response = await page.request.get(target);
        expect(response.status(), `${target} must not be a 404`).toBeLessThan(400);
      }
    });

    test('"Kirish" leads to the sign-in page', async ({ page }) => {
      await open(page, path, 1440);
      await page
        .getByRole('banner')
        .getByRole('link', { name: copy.nav.login })
        .locator('visible=true')
        .click();
      await expect(page).toHaveURL(new RegExp(`${lang === 'ru' ? '/ru' : ''}/login$`));
    });

    test('the language switch keeps the page and marks the current language', async ({ page }) => {
      await open(page, path, 1440);
      const target: Lang = lang === 'uz' ? 'ru' : 'uz';
      const group = page.getByRole('banner').getByRole('group', { name: copy.nav.language });
      await expect(group.locator('a[aria-current="true"]')).toHaveText(lang.toUpperCase());
      await group.getByRole('link', { name: langName(target, copy) }).click();
      await expect(page).toHaveURL(other === '/' ? /localhost:\d+\/$/ : /\/ru$/);
      await expect(page.locator('html')).toHaveAttribute('lang', target);
    });
  });

  test.describe(`${lang}: keyboard`, () => {
    test('desktop: the whole header is reachable with Tab, in reading order', async ({ page }) => {
      await open(page, path, 1440);
      const order: string[] = [];
      for (let i = 0; i < 9; i += 1) {
        await page.keyboard.press('Tab');
        order.push(await focusedName(page));
      }
      expect(order).toEqual([
        copy.nav.skip,
        copy.nav.home.replace('{brand}', brand),
        copy.nav.products,
        copy.nav.how,
        copy.nav.faq,
        langName('uz', copy),
        langName('ru', copy),
        copy.nav.login,
        copy.nav.openTelegram,
      ]);
    });

    test('the skip link moves past the header', async ({ page }) => {
      await open(page, path, 1440);
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: copy.nav.skip })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#main-content$/);
      await page.keyboard.press('Tab');
      // The next stop is after the header: the footer (the home page has no controls of its own).
      expect(
        await page.evaluate(() => document.activeElement?.closest('header') ?? null),
      ).toBeNull();
    });

    test('mobile: the menu opens with Enter, Tab walks it, Escape closes it and returns the focus', async ({
      page,
    }) => {
      await open(page, path, 375, 812);
      const button = page.getByRole('button', { name: copy.nav.menu });
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      const walk: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        walk.push(await focusedName(page));
      }
      expect(walk).toEqual([
        copy.nav.products,
        copy.nav.how,
        copy.nav.faq,
        langName('uz', copy),
        langName('ru', copy),
        copy.nav.openTelegram,
      ]);
      await page.keyboard.press('Escape');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toBeFocused();
    });

    test('mobile: a section link closes the menu and goes to the landing', async ({ page }) => {
      await open(page, path, 375, 812);
      const button = page.getByRole('button', { name: copy.nav.menu });
      await button.click();
      await page.getByRole('link', { name: copy.nav.faq }).first().click();
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(page).toHaveURL(new RegExp(`${lang === 'ru' ? '/ru' : '/'}#faq$`));
    });
  });

  test.describe(`${lang}: accessibility`, () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [375, 768, 1440]) {
        test(`${scheme} ${width}px: no critical or serious findings, no overflow`, async ({
          page,
        }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await open(page, path, width);
          expect(await seriousViolations(page)).toEqual([]);
          expect(await overflow(page)).toBeLessThanOrEqual(0);
          if (width < 1041) {
            await page.getByRole('button', { name: copy.nav.menu }).click();
            await expect(page.getByRole('link', { name: copy.nav.faq }).first()).toBeVisible();
            expect(await seriousViolations(page)).toEqual([]);
            expect(await overflow(page)).toBeLessThanOrEqual(0);
          }
        });
      }
    }
  });
}
