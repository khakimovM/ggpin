import { BRAND } from '@repo/shared';
import { expect, test } from '@playwright/test';
import { axeViolations, overflow } from '../tg/support';
import { SCHEMES, TEXT, openStore } from './catalog-support';
import { HEADER_ROW, box, desktop, phone } from './layout-support';

// The desktop finish of the web store (phase 7 S10), part 1: the header, the footer and the catalog
// banner at 375 / 768 / 1440, in both languages and themes, plus reduced motion. Written by width
// bucket so one file runs in every viewport project. Part 2 (pages and modals): layout-pages.spec.ts.

test.describe('the header', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: what is in the row, what is under it, what moved into the menu`, async ({
        page,
      }) => {
        const t = TEXT[lang].web.nav;
        await openStore(page, { lang, scheme });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const nav = page.getByRole('navigation', { name: t.main });
        const search = page.getByRole('searchbox');
        const balance = page.getByTestId('header-balance');

        // The three screens from 768 px (Store.dc.html keeps them on the tablet too).
        if (phone(page)) await expect(nav).toBeHidden();
        else {
          await expect(nav.getByRole('link')).toHaveCount(3);
          for (const link of await nav.getByRole('link').all()) {
            expect((await box(link)).y + (await box(link)).height).toBeLessThanOrEqual(HEADER_ROW);
          }
        }
        // The search: in the row from 1024 px, on a row of its own below it.
        const field = await box(search);
        if (desktop(page)) expect(field.y + field.height).toBeLessThanOrEqual(HEADER_ROW);
        else expect(field.y).toBeGreaterThanOrEqual(HEADER_ROW);
        // The balance is always in the row; language and theme are in it from 1024 px only.
        expect((await box(balance)).y).toBeLessThan(HEADER_ROW);
        const langSwitch = page.getByRole('radio', { name: t.langRu });
        const themeButton = page.getByRole('button', { name: t.theme });
        if (desktop(page)) {
          await expect(langSwitch).toBeVisible();
          await expect(themeButton).toBeVisible();
        } else {
          await expect(langSwitch).toBeHidden();
          await expect(themeButton).toBeHidden();
          await page.getByRole('button', { name: t.menu }).click();
          await expect(
            page.locator('#account-menu').getByRole('radio', { name: t.langRu }),
          ).toBeVisible();
          // The history is in the menu only where the nav is not.
          await expect(
            page.locator('#account-menu').getByRole('link', { name: t.orders }),
          ).toHaveCount(phone(page) ? 1 : 0);
        }
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }

  test('keyboard: Tab walks the screens, then on to the search or the balance', async ({
    page,
  }) => {
    const t = TEXT.uz.web.nav;
    await openStore(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (phone(page)) return; // no nav on a phone: covered by the menu test in header.spec.ts
    const nav = page.getByRole('navigation', { name: t.main });
    await nav.getByRole('link', { name: t.catalog }).focus();
    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: t.orders })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: t.profile })).toBeFocused();
    await page.keyboard.press('Tab');
    if (desktop(page)) await expect(page.getByRole('searchbox')).toBeFocused();
    else await expect(page.getByRole('button', { name: t.topUp })).toBeFocused();
  });

  test('money keeps its unit on the same line: a no-break space between the number and "so‘m" / "сум"', async ({
    page,
  }) => {
    for (const lang of ['uz', 'ru'] as const) {
      await openStore(page, { lang });
      const text = await page.getByTestId('header-balance').textContent();
      const nbsp = String.fromCharCode(160);
      expect(text ?? '').toMatch(new RegExp(String.raw`\d${nbsp}(so‘m|сум)$`));
    }
  });
});

test.describe('the footer', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: the copyright and the way to reach us, at the end of every page`, async ({
      page,
    }) => {
      await openStore(page, { lang });
      const footer = page.getByRole('contentinfo');
      await expect(footer).toContainText(new RegExp(`© \\d{4} ${BRAND.name}`));
      await expect(
        footer.getByRole('link', { name: TEXT[lang].web.footer.contact }),
      ).toHaveAttribute('href', /^https:\/\/t\.me\//);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('the catalog banner', () => {
  test('two announcements, dots that move between them, only the current one reachable', async ({
    page,
  }) => {
    await openStore(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const banner = page.getByTestId('promo');
    if (phone(page)) {
      await expect(banner).toBeHidden(); // 390 px web is the Mini App's layout
      return;
    }
    await expect(
      page.getByRole('heading', { level: 1, name: TEXT.uz.store.catalog.allProducts }),
    ).toBeVisible();
    // Both slides are in the page; the one out of sight is aria-hidden, so a role query skips it.
    const slides = banner.locator('[data-slide]');
    await expect(slides).toHaveCount(2);
    await expect(
      banner.getByRole('link', { name: TEXT.uz.store.catalog.promo.referral.cta }),
    ).toHaveAttribute('href', '/store/profile');
    await expect(
      banner.getByRole('link', { name: TEXT.uz.store.catalog.promo.gift.cta }),
    ).toHaveCount(0);
    await banner
      .getByRole('button', { name: TEXT.uz.store.catalog.promo.slide.replace('{number}', '2') })
      .click();
    await expect(
      banner.getByRole('link', { name: TEXT.uz.store.catalog.promo.gift.cta }),
    ).toBeVisible();
    await expect(
      banner.getByRole('link', { name: TEXT.uz.store.catalog.promo.gift.cta }),
    ).toHaveAttribute('href', '/store/products/telegram-premium');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  for (const scheme of SCHEMES) {
    test(`${scheme}: passes the contrast and keyboard checks, in both languages`, async ({
      page,
    }) => {
      for (const lang of ['uz', 'ru'] as const) {
        await openStore(page, { lang, scheme });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        if (phone(page)) continue;
        await page
          .getByTestId('promo')
          .getByRole('button', {
            name: new RegExp(`${lang === 'uz' ? '2-eʼlon' : 'Объявление 2'}`),
          })
          .click();
        // No sleep: axeViolations waits for the slide (a transition) to finish before it scans.
        expect(await axeViolations(page)).toEqual([]);
      }
    });
  }

  test('it is gone once a category or a search narrows the catalog', async ({ page }) => {
    await openStore(page, { path: '/store?category=games' });
    await expect(page.getByRole('heading', { level: 1, name: 'O‘yinlar' })).toBeVisible();
    await expect(page.getByTestId('promo')).toHaveCount(0);
  });

  test('reduced motion: the strip jumps instead of sliding', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStore(page);
    if (phone(page)) return;
    const track = page.getByTestId('promo').getByRole('group').first().locator('xpath=..');
    const seconds = await track.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(Number.parseFloat(seconds)).toBeLessThanOrEqual(0.001);
  });

  test('from 1024 px the categories carry their icons', async ({ page }) => {
    await openStore(page);
    if (!desktop(page)) return;
    const rows = page
      .getByRole('complementary', { name: TEXT.uz.store.catalog.categories.label })
      .getByRole('button');
    await expect(rows).toHaveCount(4);
    for (const row of await rows.all()) await expect(row.locator('svg')).toHaveCount(1);
  });
});
