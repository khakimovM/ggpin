import { expect, test, type Page } from '@playwright/test';
import { INTENT_ID } from '../fixtures/payments';
import { tgPressMain } from '../fixtures/telegram';
import { shot } from '../pay/pay-support';
import { axeViolations, overflow } from './support';
import { SCHEMES, openLinks, openTopup, storeTopup, tgTopup, type Lang } from './topup-support';

// The Mini App top-up, waiting side (phase 7 S8, TopupMini.dc.html `waiting`): an unfinished request
// offered first, the waiting screen and its ends, the pill on the home screen.

const LANGS: Lang[] = ['uz', 'ru'];
const main = (page: Page) => page.locator('main');
const WAITING = `/tg/topup/${INTENT_ID}`;
const tick = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test.describe('an unfinished request', () => {
  for (const lang of LANGS) {
    test(`${lang}: offered first, with the amount, the time left and the transfer notes`, async ({
      page,
    }, testInfo) => {
      const s = storeTopup(lang);
      await openTopup(page, { lang, payments: { preset: true } });
      const sheet = page.getByRole('dialog');
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(s.pending.title);
      await expect(sheet).toContainText(/50\s347/);
      await expect(sheet).toContainText(/\d+:\d\d/);
      const notes = sheet.getByRole('note');
      for (const key of ['exact', 'cardChanges', 'own', 'noCancelled'] as const) {
        await expect(notes).toContainText(tgTopup(lang).notes[key]);
      }
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `tg-topup-pending-${lang}-light`);
    });
  }

  test('"open the payment page" asks for a fresh link and goes to the waiting screen', async ({
    page,
  }) => {
    const api = await openTopup(page, { payments: { preset: true } });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: storeTopup('uz').pending.open })
      .click();
    await expect(page).toHaveURL(new RegExp(`${WAITING}$`));
    expect(api.payLinks()).toBe(1);
    expect(await openLinks(page)).toHaveLength(1);
  });

  test('"cancel and start a new one" asks first, then cancels', async ({ page }) => {
    const s = storeTopup('uz');
    const api = await openTopup(page, { payments: { preset: true } });
    await page.getByRole('dialog').getByRole('button', { name: s.pending.cancelNew }).click();
    const confirm = page.getByRole('dialog', { name: s.cancelDialog.title });
    await expect(confirm).toContainText(s.cancelDialog.note);
    expect(api.cancels()).toBe(0);
    await confirm.getByRole('button', { name: s.cancelDialog.yes }).click();
    await expect.poll(() => api.cancels()).toBe(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: s.amount.label })).toBeVisible();
  });

  test('a creation that meets a waiting request (409) leads to the same sheet', async ({
    page,
  }) => {
    const api = await openTopup(page, { payments: { create: 'pending' } });
    await page.getByRole('button', { name: '50 000' }).click();
    await tgPressMain(page);
    await expect(page.getByRole('dialog')).toContainText(storeTopup('uz').pending.title);
    expect(api.creates).toHaveLength(1);
  });
});

test.describe('waiting', () => {
  for (const lang of LANGS) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: amount, countdown, status, notes, reopen`, async ({
        page,
      }, testInfo) => {
        const w = tgTopup(lang).waiting;
        const api = await openTopup(page, {
          lang,
          scheme,
          path: WAITING,
          payments: { preset: true },
        });
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.title);
        await expect(main(page)).toContainText(w.line);
        await expect(main(page)).toContainText(/50\s347/);
        await expect(page.getByTestId('topup-left')).toContainText(/\d+:\d\d/);
        await expect(page.getByRole('status').filter({ hasText: w.status })).toBeVisible();
        // The transfer notes, in a note block beside the amount (docs/04 "Frontend talablari" 7).
        const notes = main(page).getByRole('note');
        for (const key of ['exact', 'cardChanges', 'own', 'noCancelled'] as const) {
          await expect(notes).toContainText(tgTopup(lang).notes[key]);
        }
        await expect(page.locator('body')).not.toContainText('9860');
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `tg-topup-waiting-${lang}-${scheme}`);

        await page.getByRole('button', { name: w.reopen, exact: true }).click();
        await expect.poll(() => api.payLinks()).toBe(1);
        await expect.poll(async () => (await openLinks(page)).length).toBe(1);
      });
    }
  }

  test('two quick presses of "reopen" ask for one link', async ({ page }) => {
    const api = await openTopup(page, { path: WAITING, payments: { preset: true } });
    await page.getByRole('button', { name: tgTopup('uz').waiting.reopen }).dblclick();
    await expect.poll(() => api.payLinks()).toBe(1);
    await page.waitForTimeout(500);
    expect(api.payLinks()).toBe(1);
  });

  test('a link on another origin is refused: the error is shown, nothing opens', async ({
    page,
  }) => {
    await openTopup(page, {
      path: WAITING,
      payments: { preset: true, redirect: 'foreign' },
    });
    await page.getByRole('button', { name: tgTopup('uz').waiting.reopen }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: tgTopup('uz').waiting.linkError }),
    ).toBeVisible();
    expect(await openLinks(page)).toEqual([]);
  });

  test('a client that refuses the link: the error, then a button whose press opens it', async ({
    page,
  }) => {
    const w = tgTopup('uz').waiting;
    await openTopup(page, { path: WAITING, refusals: 1, payments: { preset: true } });
    await page.getByRole('button', { name: w.reopen, exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: w.linkError })).toBeVisible();
    await page.getByRole('button', { name: w.openPage, exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: w.linkError })).toHaveCount(0);
    expect(await openLinks(page)).toHaveLength(2);
  });

  test('credited: the credited amount, the wallet balance, back to the purchase through ?from=', async ({
    page,
  }) => {
    const c = tgTopup('uz').credited;
    const api = await openTopup(page, {
      path: `${WAITING}?from=%2Ftg%2Fproduct%2Fstars`,
      // What the server says was credited is what is shown, not the amount to transfer.
      payments: { preset: true, creditedTiyin: '5030000' },
    });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    api.setStatus('PAID');
    await tick(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.title, { timeout: 15_000 });
    await expect(main(page)).toContainText(/\+50\s300/);
    await expect(main(page)).not.toContainText(/50\s347/);
    await expect(main(page)).toContainText(/Balans/);
    await expect(page.getByRole('button', { name: c.buy })).toBeVisible();
    // With a purchase to go back to, "home" is still there as the second way.
    await expect(page.getByRole('button', { name: c.home })).toBeVisible();
  });

  test('credited without ?from= has only "home"', async ({ page }) => {
    const c = tgTopup('uz').credited;
    const api = await openTopup(page, { path: WAITING, payments: { preset: true } });
    await expect(page.getByTestId('topup-left')).toBeVisible();
    api.setStatus('PAID');
    await expect(page.getByRole('button', { name: c.home })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: c.buy })).toHaveCount(0);
  });

  for (const from of ['https%3A%2F%2Fevil.example%2Fx', '%2Ftg%2F%252e%252e%2Flogin']) {
    test(`a foreign ?from= is ignored: ${from}`, async ({ page }) => {
      const c = tgTopup('uz').credited;
      const api = await openTopup(page, {
        path: `${WAITING}?from=${from}`,
        payments: { preset: true },
      });
      await expect(page.getByTestId('topup-left')).toBeVisible();
      api.setStatus('PAID');
      await tick(page);
      await expect(page.getByRole('button', { name: c.home })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: c.buy })).toHaveCount(0);
    });
  }

  for (const lang of LANGS) {
    test(`${lang}: expired keeps the reassurance, cancelled says what to do about money already sent`, async ({
      page,
    }, testInfo) => {
      const t = tgTopup(lang);
      const api = await openTopup(page, { lang, path: WAITING, payments: { preset: true } });
      await expect(page.getByTestId('topup-left')).toBeVisible();
      api.setStatus('EXPIRED');
      await tick(page);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.expired.title, {
        timeout: 15_000,
      });
      await expect(main(page)).toContainText(t.expired.body);
      await expect(page.getByRole('link', { name: t.expired.newPayment })).toBeVisible();
      await shot(page, testInfo, `tg-topup-expired-${lang}-light`);

      api.setStatus('CANCELLED');
      await tick(page);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.cancelled.title, {
        timeout: 15_000,
      });
      await expect(main(page)).toContainText(t.cancelled.body);
      // No support link is configured here: the button leads to our own bot instead.
      await expect(page.getByRole('button', { name: t.cancelled.support })).toBeVisible();
      await shot(page, testInfo, `tg-topup-cancelled-${lang}-light`);
    });
  }

  test('an expired request that is credited later turns into the credited screen', async ({
    page,
  }) => {
    const api = await openTopup(page, { path: WAITING, payments: { preset: true } });
    api.setStatus('EXPIRED');
    await tick(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tgTopup('uz').expired.title, {
      timeout: 15_000,
    });
    api.setStatus('PAID');
    await tick(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tgTopup('uz').credited.title, {
      timeout: 15_000,
    });
  });

  test('cancel asks first; the cancel is sent once confirmed and the card of the request is gone', async ({
    page,
  }) => {
    const s = storeTopup('uz');
    const api = await openTopup(page, { path: WAITING, payments: { preset: true } });
    await page.getByRole('button', { name: tgTopup('uz').waiting.cancel }).click();
    const confirm = page.getByRole('dialog', { name: s.cancelDialog.title });
    await expect(confirm).toContainText(s.cancelDialog.note);
    await confirm.getByRole('button', { name: s.cancelDialog.no }).click();
    await expect(confirm).toHaveCount(0);
    expect(api.cancels()).toBe(0);
    await page.getByRole('button', { name: tgTopup('uz').waiting.cancel }).click();
    await confirm.getByRole('button', { name: s.cancelDialog.yes }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tgTopup('uz').cancelled.title);
    expect(api.cancels()).toBe(1);
  });

  test('a request that is not the visitor’s is "not found"', async ({ page }) => {
    await openTopup(page, { path: '/tg/topup/cm3someoneelse000000000001' });
    await expect(page.getByText(tgTopup('uz').waiting.notFound.title)).toBeVisible();
  });
});

test.describe('home', () => {
  test('the pill shows the amount and the time while a request waits, and it leads back', async ({
    page,
  }) => {
    await openTopup(page, { path: '/tg', payments: { preset: true } });
    const pill = page.getByTestId('topup-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/50\s347/);
    await expect(pill).toContainText(/\d+:\d\d/);
    await pill.click();
    await expect(page).toHaveURL(new RegExp(`${WAITING}$`));
  });

  test('no pill without a waiting request', async ({ page }) => {
    await openTopup(page, { path: '/tg' });
    await expect(page.getByRole('heading', { level: 1, name: 'Sardor' })).toBeVisible();
    await expect(page.getByTestId('topup-pill')).toHaveCount(0);
  });
});
