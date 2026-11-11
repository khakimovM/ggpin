import { expect, test, type Page } from '@playwright/test';
import { openStoreAccount } from './account-support';
import { openStore } from './catalog-support';
import { openStoreOrder, openStoreProduct, reachStoreConfirm, type Lang } from './checkout-support';
import { saveShot } from './shot-file';
import { openModal } from './topup-support';

// Desktop screenshots of the web store (phase 7 S10, QA material for the owner): one file per
// screen, width, theme and language, written into $SHOTS_DIR. Without the variable the file
// registers no tests, so the normal run is unaffected. SHOTS_FULL=1 adds the rest of the matrix.

const DIR = process.env.SHOTS_DIR;
const COMBOS: Array<[Lang, 'light' | 'dark']> = process.env.SHOTS_FULL
  ? [
      ['uz', 'light'],
      ['uz', 'dark'],
      ['ru', 'light'],
      ['ru', 'dark'],
    ]
  : [
      ['uz', 'light'],
      ['ru', 'dark'],
    ];

const PRESET = {
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  quantity: 500,
  totalTiyin: '11000000',
} as const;

// Ready to shoot: fonts loaded and every finite animation (entrance, slide, pop) finished; loops
// (the pulse, the gradient drift) are left running. No fixed sleep.
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  });
}

const heading = (page: Page) => expect(page.getByRole('heading', { level: 1 })).toBeVisible();

if (DIR !== undefined && DIR !== '') {
  for (const [lang, scheme] of COMBOS) {
    test.describe(`${lang} / ${scheme}`, () => {
      const name = (screen: string) => `${screen}-${lang}-${scheme}`;

      test('catalog and the menu', async ({ page }) => {
        await openStore(page, { lang, scheme });
        await heading(page);
        await expect(page.getByRole('list').getByRole('listitem').first()).toBeVisible();
        await settle(page);
        await saveShot(page, DIR, name('catalog'));
        await page.locator('button[aria-controls="account-menu"]').click();
        await expect(page.locator('#account-menu')).toBeVisible();
        await settle(page);
        await saveShot(page, DIR, name('menu'), { fullPage: false });
      });

      test('product and the confirmation', async ({ page }) => {
        await openStoreProduct(page, 'telegram-stars', { lang, scheme });
        await heading(page);
        await settle(page);
        await saveShot(page, DIR, name('product'));
        await reachStoreConfirm(page, lang);
        await expect(page.getByRole('dialog')).toBeVisible();
        await settle(page);
        await saveShot(page, DIR, name('confirm'), { fullPage: false });
      });

      test('insufficient', async ({ page }) => {
        await openStoreProduct(page, 'telegram-stars', {
          lang,
          scheme,
          orders: { balanceTiyin: '500000' },
        });
        await reachStoreConfirm(page, lang);
        // The server answers the payment with the numbers; the sheet below is its answer.
        await page.getByRole('dialog').getByRole('button').last().click();
        await expect(page.getByRole('dialog').getByRole('heading').first()).toBeVisible();
        await settle(page);
        await saveShot(page, DIR, name('insufficient'), { fullPage: false });
      });

      test('order', async ({ page }) => {
        await openStoreOrder(page, 'order_x', {
          lang,
          scheme,
          orders: { preset: PRESET, statuses: ['PROCESSING'] },
        });
        await heading(page);
        await settle(page);
        await saveShot(page, DIR, name('order'));
      });

      test('history and profile', async ({ page }) => {
        await openStoreAccount(page, '/store/orders', { lang, scheme });
        await heading(page);
        await expect(page.getByRole('table')).toBeVisible();
        await settle(page);
        await saveShot(page, DIR, name('history'));
        await openStoreAccount(page, '/store/profile', { lang, scheme });
        await heading(page);
        await settle(page);
        await saveShot(page, DIR, name('profile'));
      });

      test('top-up modal', async ({ page }) => {
        await openModal(page, lang, undefined, scheme);
        await settle(page);
        await saveShot(page, DIR, name('topup'), { fullPage: false });
      });
    });
  }
}
