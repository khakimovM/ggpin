import { expect, test } from '@playwright/test';
import { INTENT_ID, PAY_TOKEN } from '../fixtures/payments';
import { axeViolations, overflow } from '../tg/support';
import { DONE_KEY, SCHEMES, STORE_KEY, main, noToken, openPay, shot, t } from './pay-support';

// The payment page /pay/<intentId> (phase 7 S8, PayPage.dc.html): the card and the EXACT amount of
// one top-up request, for a visitor with no session, who arrives with a capability token in the
// URL fragment. Its ends, a failing network and its headers: pay-ends.spec.ts.

test.describe('the token in the address', () => {
  test('is read once, sent in a header, and gone from the address bar; ?locale= stays', async ({
    page,
  }) => {
    const api = await openPay(page, { lang: 'ru' });
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    await expect.poll(() => noToken(page.url())).toBe(true);
    expect(new URL(page.url()).search).toBe('?locale=ru');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('ru').title);

    // The first answer came with the token in X-Pay-Token, without a cookie; never in a URL.
    expect(api.payViews[0]).toMatchObject({ token: PAY_TOKEN, cookie: false });
    for (const view of api.payViews) expect(view.url).not.toContain(PAY_TOKEN);
  });

  test('stays out of the address after router.refresh() and a language switch', async ({
    page,
  }) => {
    await openPay(page);
    await expect.poll(() => noToken(page.url())).toBe(true);

    await page.evaluate(() => {
      (window as unknown as { next: { router: { refresh: () => void } } }).next.router.refresh();
    });
    await page.waitForTimeout(600);
    expect(noToken(page.url())).toBe(true);

    await page.getByRole('radio', { name: 'RU' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('ru').title);
    expect(noToken(page.url())).toBe(true);
    expect(new URL(page.url()).search).toBe('?locale=ru');
    // The token still works: the page did not lose it with the fragment.
    await expect(page.getByTestId('pay-amount')).toBeVisible();
  });

  test('lives in this tab’s sessionStorage only: never localStorage or a cookie', async ({
    page,
    context,
  }) => {
    await openPay(page);
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    const stored = await page.evaluate(
      ([key]) => ({
        local: JSON.stringify(Object.entries(localStorage)),
        session: sessionStorage.getItem(key ?? ''),
      }),
      [STORE_KEY],
    );
    expect(stored.local).not.toContain(PAY_TOKEN);
    expect(JSON.parse(stored.session ?? 'null')).toMatchObject({
      intentId: INTENT_ID,
      token: PAY_TOKEN,
    });
    expect(JSON.stringify(await context.cookies())).not.toContain(PAY_TOKEN);
  });

  test('a reload, and back from another page, keep working (no fragment needed any more)', async ({
    page,
  }) => {
    const api = await openPay(page);
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    // (WebKit reloads the address it was first opened with; the page strips the fragment again.)
    await expect.poll(() => page.url()).not.toContain('#t=');
    await page.goto('/pay/cm3other0000000000000000001');
    await page.goBack();
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    for (const view of api.payViews) expect(view.url).not.toContain(PAY_TOKEN);
    expect(api.payViews.at(-1)?.token).toBe(PAY_TOKEN);
  });

  test('is erased the moment the request has ended; a reload says only that it is finished', async ({
    page,
  }) => {
    const api = await openPay(page);
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    api.setStatus('PAID');
    await expect(page.locator('[data-final="credited"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pay-credited-owner')).toContainText('S***r');
    // The token is gone; a marker with no secret in it took its place.
    const stored = await page.evaluate(
      ([token, done]) => ({
        token: sessionStorage.getItem(token ?? ''),
        done: sessionStorage.getItem(done ?? ''),
      }),
      [STORE_KEY, DONE_KEY],
    );
    expect(stored.token).toBeNull();
    expect(JSON.parse(stored.done ?? 'null')).toEqual({ intentId: INTENT_ID, status: 'PAID' });
    expect(stored.done).not.toContain(PAY_TOKEN);

    const asked = api.payViews.length;
    await page.reload();
    await expect(page.locator('[data-final="done"]')).toBeVisible();
    await expect(main(page)).toContainText(t('uz').done.title);
    await expect(main(page)).toContainText(t('uz').done.body);
    for (const shown of [/50\s347/, /9860/, /S\*\*\*r/]) {
      await expect(main(page)).not.toContainText(shown);
    }
    await expect(main(page)).not.toContainText(t('uz').invalid.title);
    await expect(page.getByRole('link', { name: t('uz').cta.bot })).toHaveAttribute(
      'href',
      'https://t.me/ggpin_bot',
    );
    expect(api.payViews.length).toBe(asked); // nothing was asked: there is no token to ask with
  });

  test('is erased when the server stops knowing it (404)', async ({ page }) => {
    const api = await openPay(page);
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    api.setPayView('notFound');
    await expect(page.locator('[data-final="invalid"]')).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), STORE_KEY)).toBeNull();
  });

  test('a link with no token (and no session of the web store) asks for nothing', async ({
    page,
  }) => {
    const api = await openPay(page, { hash: null });
    await expect(page.locator('[data-final="invalid"]')).toBeVisible();
    expect(api.payViews).toEqual([]);
  });

  test('a link with no token and no marker is "link expired or wrong", with the hint', async ({
    page,
  }) => {
    await openPay(page, { hash: null });
    await expect(main(page)).toContainText(t('uz').invalid.title);
    await expect(main(page)).toContainText(t('uz').invalid.hint);
    await expect(page.getByTestId('pay-card-number')).toHaveCount(0);
  });

  test('a token the server does not know (404) is the same screen', async ({ page }) => {
    await openPay(page, { payments: { payView: 'notFound' } });
    await expect(main(page)).toContainText(t('uz').invalid.title);
    await expect(main(page)).toContainText(t('uz').invalid.body);
  });
});

test.describe('waiting for the money', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: the exact amount, the card, whose account, the rules`, async ({
        page,
      }, testInfo) => {
        const api = await openPay(page, { lang, scheme });
        const amount = page.getByTestId('pay-amount');
        await expect(amount).toBeVisible();
        await expect(amount).toContainText(/50\s347/);
        await expect(page.getByTestId('pay-amount-tail')).toHaveText('347');
        // The middle digits start hidden (owner decision 2026-11-09) and are not in the page at all.
        const number = page.getByTestId('pay-card-number');
        await expect(number).toHaveAccessibleName(
          t(lang).cardMasked.replace('{first}', '9860').replace('{last}', '9012'),
        );
        expect(await number.innerHTML()).not.toMatch(/1234|5678/);
        // One line of digits (28.8 px) at every width, 375 included.
        expect((await number.boundingBox())?.height).toBeLessThan(40);
        await expect(page.getByTestId('pay-card-holder')).toHaveText('ALISHER K.');
        // Whose account it tops up, and that it is only for one's own (D-37 (7)).
        await expect(page.getByTestId('pay-owner')).toContainText('S***r');
        await expect(main(page)).toContainText(t(lang).foreign);
        await expect(main(page)).toContainText(t(lang).cardChanges);
        await expect(main(page)).toContainText(t(lang).noCancelled);
        await expect(main(page)).toContainText(t(lang).warn);
        await expect(page.getByTestId('pay-left')).toContainText(/\d+:\d\d/);
        await expect(page.getByRole('status').filter({ hasText: t(lang).waiting })).toBeVisible();

        // Nothing about a wallet, a profile or a user (the page has no session).
        await expect(page.locator('body')).not.toContainText(/@aziz|Aziz|Hamyon|Кошелёк/);
        // Nothing outside this site and the API was asked for (no CDN, no analytics).
        expect(api.requested).toEqual([]);

        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `pay-pending-${lang}-${scheme}`);
      });

      // A test of its own: two axe passes in one test ran past the timeout on a loaded WebKit.
      test(`${lang} / ${scheme}: the eye shows the full card number and hides it again`, async ({
        page,
      }, testInfo) => {
        await openPay(page, { lang, scheme });
        const number = page.getByTestId('pay-card-number');
        await expect(number).not.toContainText(/1234|5678/);
        await page.getByRole('button', { name: t(lang).showCard }).click();
        await expect(number).toHaveAccessibleName('9860 1234 5678 9012');
        expect((await number.boundingBox())?.height).toBeLessThan(40);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `pay-revealed-${lang}-${scheme}`);
        await page.getByRole('button', { name: t(lang).hideCard }).click();
        await expect(number).not.toContainText(/1234|5678/);
      });
    }
  }

  test('a hint-less request still shows the "only for your own account" warning', async ({
    page,
  }) => {
    await openPay(page, { payments: { ownerHint: null } });
    await expect(page.getByTestId('pay-owner')).toHaveCount(0);
    await expect(main(page)).toContainText(t('uz').foreign);
  });

  test('copy buttons copy the digits and say what they copied (a toast and the button)', async ({
    page,
    context,
    browserName,
  }) => {
    // Only Chromium lets a test read the clipboard back; every engine shows what was copied.
    const readable = browserName === 'chromium';
    if (readable) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPay(page);
    await page
      .getByRole('button', { name: t('uz').copy })
      .first()
      .click();
    await expect(page.getByRole('button', { name: t('uz').copiedAmount })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: t('uz').copiedAmount })).toBeVisible();
    if (readable) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('50347');
    // The card's copy works on the HIDDEN number and still takes all 16 digits (checked below).
    await expect(page.getByTestId('pay-card-number')).not.toContainText(/1234|5678/);
    await page
      .getByRole('button', { name: t('uz').copy })
      .last()
      .click();
    await expect(page.getByRole('button', { name: t('uz').copiedCard })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: t('uz').copiedCard })).toBeVisible();
    if (readable) {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('9860123456789012');
    }
  });

  test('the time left turns to the warning tone under five minutes', async ({ page }, testInfo) => {
    await openPay(page, { payments: { ttlSec: 240 } });
    const timer = page.getByRole('timer');
    await expect(timer).toHaveAttribute('data-low', '');
    await expect(timer).toContainText(t('uz').lowLeft);
    await shot(page, testInfo, 'pay-low-uz-light');
  });

  test('asks again about every 5 seconds and stops once the request has ended', async ({
    page,
  }) => {
    const api = await openPay(page);
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    await expect.poll(() => api.payViews.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    api.setStatus('PAID');
    await expect(main(page)).toContainText(t('uz').credited.title, { timeout: 15_000 });
    const calls = api.payViews.length;
    await page.waitForTimeout(6_500);
    expect(api.payViews.length).toBe(calls); // polling stopped
  });
});
