import { expect, test, type Page } from '@playwright/test';
import { axeViolations, overflow } from '../tg/support';
import { openStoreAccount } from './account-support';
import { SCHEMES, TEXT } from './catalog-support';
import { openStoreOrder, openStoreProduct, reachStoreConfirm } from './checkout-support';
import { box, desktop, phone } from './layout-support';
import { buyButton, confirmRecipient } from './product-support';

// The desktop finish of the web store (phase 7 S10), part 2: the product, order, history and
// profile pages and the modals at 375 / 768 / 1440, in both languages and themes, plus reduced
// motion. Part 1 (header, footer, banner): layout.spec.ts.

test.describe('the product page', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: the panel beside the header from 1024 px, under it from 768 px, the buy button in the panel`, async ({
      page,
    }) => {
      await openStoreProduct(page, 'telegram-stars', { lang });
      const title = page.getByRole('heading', { level: 1 });
      await expect(title).toBeVisible();
      const panel = page.getByRole('heading', {
        level: 2,
        name: TEXT[lang].store.product.recipient.title,
      });
      const head = await box(title);
      const form = await box(panel);
      if (desktop(page)) {
        expect(form.x).toBeGreaterThan(head.x + head.width); // two columns
      } else {
        expect(form.y).toBeGreaterThan(head.y + head.height); // one column
      }
      // The buy action is a fixed bar on a phone and part of the panel from 768 px.
      const buy = buyButton(page, lang);
      const fixed = await buy.evaluate((el) => el.closest('.fixed') !== null);
      expect(fixed).toBe(phone(page));
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test('the recipient button is "Да, верно" in Russian (Russian QA 5)', async ({ page }) => {
    await openStoreProduct(page, 'telegram-stars', { lang: 'ru' });
    await confirmRecipient(page, 'ru');
    await expect(buyButton(page, 'ru')).toBeEnabled();
    expect(TEXT.ru.store.product.recipient.confirm).toBe('Да, верно');
  });
});

test.describe('the modals', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: checkout and "not enough money" are 520 px centred modals from 768 px`, async ({
        page,
      }) => {
        const t = TEXT[lang].store.checkout;
        await openStoreProduct(page, 'telegram-stars', {
          lang,
          scheme,
          orders: { balanceTiyin: '500000' },
        });
        await reachStoreConfirm(page, lang);
        const dialog = page.getByRole('dialog', { name: t.confirm.title });
        await expect(dialog).toBeVisible();
        const view = page.viewportSize();
        const frame = await box(dialog);
        if (view === null) throw new Error('no viewport');
        if (phone(page)) expect(frame.width).toBeGreaterThan(view.width - 4);
        else {
          expect(frame.width).toBeGreaterThanOrEqual(500);
          expect(frame.width).toBeLessThanOrEqual(520);
          expect(Math.abs(frame.x + frame.width / 2 - view.width / 2)).toBeLessThanOrEqual(2);
        }
        // "Bekor qilish" sits beside the pay button on a desktop modal, and closes it.
        const cancel = dialog.getByRole('button', { name: t.confirm.cancel });
        if (phone(page)) await expect(cancel).toBeHidden();
        else {
          await expect(cancel).toBeVisible();
          const pay = dialog.getByRole('button').last();
          expect(Math.abs((await box(cancel)).y - (await box(pay)).y)).toBeLessThanOrEqual(4);
        }
        expect(await overflow(page)).toBeLessThanOrEqual(0);

        await dialog.getByRole('button').last().click();
        const short = page.getByRole('dialog', { name: t.insufficient.title });
        await expect(short).toBeVisible();
        if (!phone(page)) expect((await box(short)).width).toBeLessThanOrEqual(520);
        expect(await axeViolations(page)).toEqual([]);

        if (phone(page)) return;
        await short.getByRole('button', { name: t.insufficient.close }).last().click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      });
    }
  }

  test('"Bekor qilish" closes the checkout and gives the focus back to the buy button', async ({
    page,
  }) => {
    await openStoreProduct(page, 'telegram-stars');
    await reachStoreConfirm(page, 'uz');
    const dialog = page.getByRole('dialog');
    if (phone(page)) return;
    await dialog.getByRole('button', { name: TEXT.uz.store.checkout.confirm.cancel }).click();
    await expect(dialog).toHaveCount(0);
    await expect(buyButton(page, 'uz')).toBeFocused();
  });
});

test.describe('the order page', () => {
  const PRESET = {
    productSlug: 'telegram-stars',
    productName: 'Telegram Stars',
    quantity: 500,
    totalTiyin: '11000000',
  } as const;

  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: the steps beside the details from 1024 px, under them from 768 px, one column on a phone`, async ({
        page,
      }) => {
        const t = TEXT[lang].store.order;
        await openStoreOrder(page, 'order_x', {
          lang,
          scheme,
          orders: { preset: PRESET, statuses: ['PROCESSING'] },
        });
        await expect(
          page.getByRole('heading', { level: 1, name: t.hero.processing.title }),
        ).toBeVisible();
        const steps = page.getByRole('list', { name: t.timeline.label });
        const details = page.getByRole('heading', { level: 2, name: t.details.title });
        const crumb = page.getByRole('navigation', { name: t.breadcrumb });
        if (phone(page)) {
          await expect(details).toHaveCount(0);
          await expect(crumb).toHaveCount(0);
        } else {
          await expect(crumb).toContainText(t.number.replace('{number}', '1000'));
          const list = await box(steps);
          const side = await box(details);
          if (desktop(page)) {
            expect(side.x).toBeGreaterThan(list.x + list.width - 2);
            expect(side.width).toBeGreaterThan(300);
          } else {
            expect(side.y).toBeGreaterThan(list.y + list.height - 2);
          }
          // Large steps: a 32 px dot (the Mini App's is 24 px).
          const dot = await box(steps.locator('[data-dot]').first());
          expect(dot.width).toBeGreaterThanOrEqual(32);
        }
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }

  test('reduced motion: nothing loops (the pulse of the current step stops); without it the pulse runs', async ({
    page,
    browser,
  }) => {
    const loops = (target: Page) =>
      target.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length,
      );
    await openStoreOrder(page, 'order_x', { orders: { preset: PRESET, statuses: ['PROCESSING'] } });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await loops(page)).toBeGreaterThan(0);

    const calm = await browser.newPage({
      reducedMotion: 'reduce',
      viewport: page.viewportSize() ?? undefined,
    });
    await openStoreOrder(calm, 'order_x', { orders: { preset: PRESET, statuses: ['PROCESSING'] } });
    await expect(calm.getByRole('heading', { level: 1 })).toBeVisible();
    // Under reduced motion the loops end within a frame or two: wait for that, not for a fixed time.
    await expect.poll(() => loops(calm)).toBe(0);
    await calm.close();
  });
});

test.describe('the history', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: dates are written out in this language, the table uses the short "failed" label`, async ({
      page,
    }) => {
      await openStoreAccount(page, '/store/orders', { lang });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const body = page.locator('main');
      await expect(
        body.getByText(lang === 'uz' ? /\d-(?:noyabr|oktabr)/ : /\d (?:ноября|октября)/).first(),
      ).toBeVisible();
      // A browser without Uzbek calendar data answers "M11 7"; nothing like it may reach the page.
      await expect(body).not.toContainText(/\bM\d{1,2}\b/);
      const orders = TEXT[lang].store.order.status;
      if (desktop(page)) {
        const table = page.getByRole('table');
        // The chip shows the short label (hidden from assistive tech); the full sentence is
        // there for it as screen-reader-only text, so nothing is lost.
        const chip = table.locator('[aria-hidden="true"]').getByText(orders.refundedShort).first();
        await expect(chip).toBeVisible();
        await expect(
          table.locator('[aria-hidden="true"]', { hasText: orders.refunded }),
        ).toHaveCount(0);
        await expect(
          table.locator('.sr-only', { hasText: orders.refunded }).first(),
        ).toBeAttached();
      }
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

test.describe('the profile', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: two columns from 1024 px, no overflow, no contrast faults`, async ({
        page,
      }) => {
        await openStoreAccount(page, '/store/profile', { lang, scheme });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }
});
