import uz from '@repo/i18n/uz.json';
import { expect, test } from '@playwright/test';
import { installCatalogApi } from '../fixtures/catalog';
import { tgCallNames, tgPressBack } from '../fixtures/telegram';
import { unexpectedProblems } from '../support/fake-api';
import { watchPage } from '../support/gallery';
import { axeViolations, overflow } from './support';
import { AMOUNT_5500, SCHEMES, TEXT, attachShot, card, chip, openHome } from './home-support';

// The Mini App home (phase 7 S5), the ready screen, the wallet card and the way out of it. The
// other states are in home-states.spec.ts.

test.describe('ready', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: profile, wallet, categories, grouped products`, async ({
        page,
      }, testInfo) => {
        const t = TEXT[lang];
        await openHome(page, { lang, scheme });

        await expect(page.getByRole('heading', { level: 1, name: 'Sardor' })).toBeVisible();
        await expect(page.getByText('@sardor_r')).toBeVisible();
        await expect(page.getByTestId('wallet-balance')).toContainText(/85.400/);
        await expect(page.getByTestId('wallet-balance')).toContainText(t.common.currency.uzs);
        await expect(page.getByRole('img', { name: /120/ })).toBeVisible(); // the coins

        // One titled section per category, in the API's order, with every product once.
        await expect(page.getByRole('heading', { level: 2 })).toHaveText([
          'Telegram',
          lang === 'uz' ? 'O‘yinlar' : 'Игры',
          lang === 'uz' ? 'Platformalar' : 'Платформы',
        ]);
        await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(7);
        await expect(chip(page, t.store.catalog.categories.all)).toHaveAttribute(
          'aria-pressed',
          'true',
        );

        // The server's price, laid out; "from" in the language's own place.
        const stars = card(page, 'Telegram Stars');
        await expect(stars).toContainText(new RegExp(AMOUNT_5500));
        await expect(stars).toContainText(lang === 'uz' ? /dan$/ : /^от|от /);
        await expect(page.getByRole('link', { name: /PUBG Mobile/ })).toContainText('GLOBAL');
        await expect(page.getByRole('link', { name: /PUBG Mobile/ })).toContainText(
          t.store.catalog.badge.popular,
        );
        await expect(page.getByRole('link', { name: /Roblox/ })).toContainText(
          t.store.catalog.badge.code,
        );

        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await attachShot(page, testInfo, `home-${lang}-${scheme}`);
      });
    }
  }

  test('no console error, no CSP violation (pictures included), no request to another origin', async ({
    page,
  }) => {
    const problems = watchPage(page);
    const violations: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as unknown as { __csp: string[] }).__csp = [
          ...((window as unknown as { __csp?: string[] }).__csp ?? []),
          `${event.violatedDirective} ${event.blockedURI}`,
        ];
      });
    });
    const origins = new Set<string>();
    page.on('request', (request) => origins.add(new URL(request.url()).origin));
    await openHome(page);
    await expect(card(page, 'PUBG Mobile').locator('img')).toBeVisible();
    violations.push(
      ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])),
    );
    expect(violations).toEqual([]);
    expect(unexpectedProblems(problems)).toEqual([]);
    // The page, the fake API and Telegram's SDK script (stubbed) only: no picture or script comes
    // from a third host.
    expect([...origins].sort()).toEqual(
      ['http://localhost:3100', 'http://localhost:5000', 'https://telegram.org'].sort(),
    );
  });

  test('a product with no fresh price shows no price, and a sold-out one says so', async ({
    page,
  }) => {
    await openHome(page);
    const freeFire = card(page, 'Free Fire');
    await expect(freeFire).toContainText(uz.store.catalog.soldOut);
    await expect(freeFire).not.toContainText(/so‘m|\d{2,}/);
    // Still a link: the product page says what is going on.
    await expect(freeFire).toHaveAttribute('href', '/tg/products/free-fire');
    await expect(card(page, 'Mobile Legends')).toContainText(/19.900/);
  });

  test('pictures are loaded from the site; a missing one shows the empty slot', async ({
    page,
  }) => {
    await openHome(page);
    const pubg = page.getByRole('link', { name: /PUBG Mobile/ }).locator('img');
    await expect(pubg).toBeVisible();
    await expect
      .poll(() => pubg.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    // `missing.svg` is a 404: the glyph on the muted box, still named after the product.
    await expect(card(page, 'Free Fire').locator('img')).toHaveCount(0);
    await expect(card(page, 'Free Fire').getByRole('img', { name: 'Free Fire' })).toBeVisible();
  });

  test('the requests carry the language, and categories and products are public', async ({
    page,
  }) => {
    const api = await openHome(page, { lang: 'ru' });
    await expect(page.getByRole('heading', { level: 1, name: 'Sardor' })).toBeVisible();
    const products = api.productRequests();
    expect(products.length).toBeGreaterThan(0);
    for (const url of products) {
      expect(url.searchParams.get('locale')).toBe('ru');
      expect(url.searchParams.get('limit')).toBe('100');
    }
    const categories = api.requests.filter((u) => u.pathname.endsWith('/catalog/categories'));
    expect(categories.map((u) => u.searchParams.get('locale'))).toContain('ru');
  });
});

test.describe('wallet card', () => {
  test('top-up leads to /tg/topup; the bonus code is shown but not pressable, help leads to /tg/help', async ({
    page,
  }) => {
    const api = await openHome(page);
    const t = uz.wallet.card;
    const topUp = page.getByRole('link', { name: new RegExp(t.topUp) });
    await expect(topUp).toHaveAttribute('href', '/tg/topup');
    await expect(topUp).not.toContainText(t.soon);
    const bonus = page.getByRole('button', { name: new RegExp(t.bonus) });
    await expect(bonus).toHaveAttribute('aria-disabled', 'true');
    await expect(bonus).toContainText(t.soon);
    const before = api.requests.length;
    await bonus.click({ force: true });
    expect(page.url()).toMatch(/\/tg$/);
    expect(api.requests.length).toBe(before);
    // Help is the Mini App's own screen (phase 7 S9), whatever support link is configured.
    const help = page.getByRole('link', { name: new RegExp(t.help) });
    await expect(help).toHaveAttribute('href', '/tg/help');
    await expect(help).not.toContainText(t.soon);
  });

  test('a wallet that cannot be loaded says so and retries, apart from the catalog', async ({
    page,
  }) => {
    await openHome(page, { catalog: { wallet: 'error' } });
    const t = uz.wallet.card;
    await expect(page.getByText(t.error.title)).toBeVisible();
    await expect(card(page, 'Telegram Stars')).toBeVisible();
    await installCatalogApi(page);
    await page.getByRole('button', { name: uz.common.retry }).first().click();
    await expect(page.getByTestId('wallet-balance')).toContainText(/85.400/);
  });

  test('the balance is the server string, exactly, also a large one', async ({ page }) => {
    await openHome(page, { catalog: { balanceTiyin: '900719925474099300' } });
    // Above 2^53 tiyin: shown without animation, not one digit lost on the way.
    await expect(page.getByTestId('wallet-balance')).toContainText(/9.007.199.254.740.993/);
  });
});

test.describe('navigation', () => {
  test('a card opens the product screen, and the BackButton brings the visitor back', async ({
    page,
  }) => {
    await openHome(page);
    await expect(card(page, 'PUBG Mobile')).toBeVisible();
    // Home has no BackButton.
    expect(await tgCallNames(page)).not.toContain('BackButton.show');

    await card(page, 'PUBG Mobile').click();
    await expect(page).toHaveURL(/\/tg\/products\/pubg-mobile$/);
    await expect.poll(() => tgCallNames(page)).toContain('BackButton.show');

    // The app pushed this screen itself, so "back" is a real step back to the home page.
    await tgPressBack(page);
    await expect(page).toHaveURL(/\/tg$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sardor' })).toBeVisible();
    await expect.poll(() => tgCallNames(page)).toContain('BackButton.hide');
  });
});
