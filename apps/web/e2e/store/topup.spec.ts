import { expect, test } from '@playwright/test';
import { installPaymentsApi } from '../fixtures/payments';
import { shot as saveShot } from '../pay/pay-support';
import { axeViolations, overflow } from '../tg/support';
import { SCHEMES, TEXT } from './catalog-support';
import { openStoreProduct, reachStoreConfirm } from './checkout-support';
import { field, modal, openModal, pay, plus, t } from './topup-support';

// The web store's top-up modal (phase 7 S8, PayPage.dc.html mode=store): amount, then the SAME
// payment screen as /pay, fed by the signed-in owner's request (the session, no link, no token).
// Closing and opening again, and the server's answers: topup-reopen.spec.ts.

const STARS = 'telegram-stars';

test.describe('the amount step', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: opens from the header "+", two steps, limits, how it works`, async ({
        page,
      }, testInfo) => {
        await openModal(page, lang, undefined, scheme);
        const dialog = modal(page, lang);
        await expect(dialog).toContainText(t(lang).steps.amount);
        await expect(dialog).toContainText(t(lang).steps.pay);
        await expect(field(page, lang)).toBeVisible();
        await expect(dialog).toContainText(/5\s000/);
        await expect(dialog.getByRole('radio', { name: t(lang).cardType.auto })).toBeChecked();
        await expect(dialog).toContainText(t(lang).how.one);
        // Not ready yet: nothing to continue with.
        await expect(dialog.getByRole('button', { name: t(lang).continue })).toBeDisabled();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await saveShot(page, testInfo, `store-topup-amount-${lang}-${scheme}`);
      });
    }
  }

  test('keyboard: Escape closes, focus returns to the "+"', async ({ page }) => {
    await openModal(page);
    await page.keyboard.press('Escape');
    await expect(modal(page)).toHaveCount(0);
    await expect(plus(page)).toBeFocused();
  });

  test('the button shows the amount', async ({ page }) => {
    await openModal(page);
    await field(page).fill('50000');
    await expect(modal(page).getByRole('button', { name: /Davom etish · 50\s000/ })).toBeEnabled();
  });

  test('an amount off the step says so and cannot be sent', async ({ page }) => {
    const api = await openModal(page);
    await field(page).fill('5500');
    await expect(modal(page)).toContainText(/1\s000\sso‘mga karrali/);
    await expect(modal(page).getByRole('button', { name: /Davom etish/ })).toBeDisabled();
    expect(api.creates).toEqual([]);
  });
});

test.describe('the payment step', () => {
  test('creates the request, shows the card in the modal, never opens or builds a link', async ({
    page,
  }) => {
    const api = await openModal(page);
    await field(page).fill('50000');
    await modal(page)
      .getByRole('radio', { name: t('uz').cardType.uzcard })
      .click();
    await modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();

    const dialog = modal(page);
    await expect(dialog.getByTestId('pay-amount')).toContainText(/50\s347/);
    // The modal shares the pay page's card block: the middle digits start hidden.
    const number = dialog.getByTestId('pay-card-number');
    await expect(number).not.toContainText(/1234|5678/);
    await dialog.getByRole('button', { name: pay('uz').showCard }).click();
    await expect(number).toHaveAccessibleName('9860 1234 5678 9012');
    await expect(dialog).toContainText(pay('uz').noCancelled);
    expect(api.creates).toEqual([
      expect.objectContaining({ amountTiyin: '5000000', bank: 'UZCARD' }),
    ]);
    expect(api.creates[0]?.key).toMatch(/^[\w-]{16,}$/);
    // The owner is signed in: no public pay view, no token, no pay link.
    expect(api.payViews).toEqual([]);
    expect(api.payLinks()).toBe(0);
  });

  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: the end states in the modal - credited, expired`, async ({ page }, testInfo) => {
      const api = await openModal(page, lang);
      await field(page, lang).fill('50000');
      await modal(page, lang)
        .getByRole('button', { name: /Davom etish|Продолжить/ })
        .click();
      await expect(modal(page, lang).getByTestId('pay-amount')).toBeVisible();
      await saveShot(page, testInfo, `store-topup-pay-${lang}-light`);

      api.setStatus('PAID');
      await expect(modal(page, lang)).toContainText(pay(lang).credited.title, { timeout: 15_000 });
      await expect(modal(page, lang)).toContainText(/\+50\s347/);
      await saveShot(page, testInfo, `store-topup-credited-${lang}-light`);
      await modal(page, lang)
        .getByRole('button', { name: t(lang).modal.backToStore })
        .click();
      await expect(modal(page, lang)).toHaveCount(0);
    });
  }

  test('expired: "new payment" returns to the amount step', async ({ page }) => {
    const api = await openModal(page, 'uz', { ttlSec: 3 });
    await field(page).fill('50000');
    await modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();
    await expect(modal(page)).toContainText(pay('uz').expired.title, { timeout: 15_000 });
    await modal(page)
      .getByRole('button', { name: t('uz').modal.newPayment })
      .click();
    await expect(field(page)).toBeVisible();
    expect(api.creates).toHaveLength(1);
  });

  test('cancel asks first, then cancels and offers a new payment', async ({ page }) => {
    const api = await openModal(page);
    await field(page).fill('50000');
    await modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();
    await modal(page)
      .getByRole('button', { name: t('uz').modal.cancel })
      .click();
    const confirm = page.getByRole('dialog', { name: t('uz').cancelDialog.title });
    await expect(confirm).toContainText(t('uz').cancelDialog.note);
    await confirm.getByRole('button', { name: t('uz').cancelDialog.no }).click();
    await expect(confirm).toHaveCount(0);
    expect(api.cancels()).toBe(0);
    await modal(page)
      .getByRole('button', { name: t('uz').modal.cancel })
      .click();
    await confirm.getByRole('button', { name: t('uz').cancelDialog.yes }).click();
    await expect.poll(() => api.cancels()).toBe(1);
    await expect(modal(page)).toContainText(pay('uz').cancelled.title);
  });

  test('a waiting request (409) is shown at once as the payment step', async ({ page }) => {
    const api = await openModal(page, 'uz', { create: 'pending' });
    await field(page).fill('50000');
    await modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();
    await expect(modal(page).getByTestId('pay-amount')).toBeVisible();
    expect(api.creates).toHaveLength(1);
  });

  test('the server refusing the amount (422) is said under the field', async ({ page }) => {
    await openModal(page, 'uz', { create: 'range' });
    await field(page).fill('50000');
    await modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();
    await expect(modal(page)).toContainText(/karrali/);
    await expect(field(page)).toBeVisible();
  });

  test('no card available (503): "temporarily unavailable"', async ({ page }) => {
    await openModal(page, 'uz', { create: 'unavailable' });
    await field(page).fill('50000');
    await modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();
    await expect(modal(page)).toContainText(t('uz').unavailable.title);
  });
});

test.describe('from "Mablag‘ yetarli emas"', () => {
  test('the checkout sheet’s top-up button opens this modal, and only this', async ({ page }) => {
    await openStoreProduct(page, STARS, { orders: { balanceTiyin: '500000' } });
    const api = await installPaymentsApi(page);
    await reachStoreConfirm(page);
    await page
      .getByRole('dialog', { name: TEXT.uz.store.checkout.confirm.title })
      .getByRole('button', { name: /^To‘lash/ })
      .click();
    const sheet = page.getByRole('dialog', {
      name: TEXT.uz.store.checkout.insufficient.title,
    });
    await sheet.getByRole('button', { name: TEXT.uz.store.checkout.insufficient.topup }).click();
    await expect(modal(page)).toBeVisible();
    await expect(sheet).toHaveCount(0);
    expect(api.creates).toEqual([]);
  });
});
