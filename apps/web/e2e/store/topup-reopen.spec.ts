import { expect, test, type Page } from '@playwright/test';
import { TEXT } from './catalog-support';
import { field, modal, openModal, pay, plus, t } from './topup-support';

// The web store's top-up modal, part two (phase 7 S8): closing and opening again, and what the
// server answers to the amount.

test.describe('closing and opening again', () => {
  const pressContinue = (page: Page) =>
    modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();

  test('after a credited payment the next opening is a NEW payment, not the old end screen', async ({
    page,
  }) => {
    const api = await openModal(page);
    await field(page).fill('50000');
    await pressContinue(page);
    await expect(modal(page).getByTestId('pay-amount')).toBeVisible();
    api.setStatus('PAID');
    await expect(modal(page)).toContainText(pay('uz').credited.title, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(modal(page)).toHaveCount(0);

    await plus(page).click();
    await expect(field(page)).toBeVisible();
    await expect(modal(page)).not.toContainText(pay('uz').credited.title);
    await field(page).fill('100000');
    await pressContinue(page);
    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]?.amountTiyin).toBe('10000000');
  });

  test('a request that still waits is picked up where it was left', async ({ page }) => {
    const api = await openModal(page);
    await field(page).fill('50000');
    await pressContinue(page);
    await expect(modal(page).getByTestId('pay-card-number')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal(page)).toHaveCount(0);
    await plus(page).click();
    await expect(modal(page).getByTestId('pay-card-number')).toBeVisible();
    expect(api.creates).toHaveLength(1);
  });

  test('a cancelled request does not come back either', async ({ page }) => {
    const api = await openModal(page);
    await field(page).fill('50000');
    await pressContinue(page);
    await modal(page)
      .getByRole('button', { name: t('uz').modal.cancel })
      .click();
    await page
      .getByRole('dialog', { name: t('uz').cancelDialog.title })
      .getByRole('button', { name: t('uz').cancelDialog.yes })
      .click();
    await expect.poll(() => api.cancels()).toBe(1);
    await expect(modal(page)).toContainText(pay('uz').cancelled.title);
    await expect(page.getByTestId('pay-card-number')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await plus(page).click();
    await expect(field(page)).toBeVisible();
  });
});

test.describe('what the server answers to the amount', () => {
  const send = async (page: Page) => {
    await field(page).fill('50000');
    await modal(page)
      .getByRole('button', { name: /Davom etish/ })
      .click();
  };

  test('the credited amount is the server’s, not the amount that was to be sent', async ({
    page,
  }) => {
    const api = await openModal(page, 'uz', { creditedTiyin: '5030000' });
    await send(page);
    api.setStatus('PAID');
    await expect(modal(page)).toContainText(/\+50\s300/, { timeout: 15_000 });
    await expect(modal(page)).not.toContainText(/\+50\s347/);
  });

  test('IDEMPOTENCY_CONFLICT names the request: its end screen is shown', async ({ page }) => {
    const api = await openModal(page, 'uz', { create: 'conflict', preset: true });
    api.setStatus('EXPIRED');
    await send(page);
    await expect(modal(page)).toContainText(pay('uz').expired.title);
  });

  test('429: the seconds to wait are said and the button stays off', async ({ page }) => {
    const api = await openModal(page, 'uz', { create: 'rateLimited' });
    await send(page);
    await expect(modal(page)).toContainText(/\d+ soniyadan keyin/);
    await expect(modal(page).getByRole('button', { name: /Davom etish/ })).toBeDisabled();
    expect(api.creates).toHaveLength(1);
  });

  test('the methods fail to load: an error with a retry', async ({ page }) => {
    await openModal(page, 'uz', { methods: 'error' });
    await expect(modal(page).getByRole('button', { name: TEXT.uz.common.retry })).toBeVisible();
    await expect(field(page)).toHaveCount(0);
  });
});
