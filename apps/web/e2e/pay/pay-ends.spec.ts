import { expect, test } from '@playwright/test';
import { INTENT_ID } from '../fixtures/payments';
import { axeViolations, overflow } from '../tg/support';
import { SCHEMES, main, openPay, shot, t } from './pay-support';

// The payment page, part two (phase 7 S8): the ends of a request, a failing network, and what the
// server sends with the page.

test.describe('the ends', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: credited, expired, a lost token`, async ({ page }, testInfo) => {
        const api = await openPay(page, { lang, scheme });
        await expect(page.getByTestId('pay-amount')).toBeVisible();

        api.setStatus('PAID');
        await expect(page.locator('[data-final="credited"]')).toBeVisible({ timeout: 15_000 });
        await expect(main(page)).toContainText(t(lang).credited.title);
        await expect(main(page)).toContainText(/\+50\s347/);
        await expect(main(page)).toContainText(t(lang).credited.sub);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `pay-credited-${lang}-${scheme}`);
      });

      test(`${lang} / ${scheme}: the time ran out`, async ({ page }, testInfo) => {
        await openPay(page, { lang, scheme, payments: { ttlSec: 2 } });
        await expect(page.locator('[data-final="expired"]')).toBeVisible({ timeout: 15_000 });
        await expect(main(page)).toContainText(t(lang).expired.title);
        // The reassurance: money sent in time is still credited.
        await expect(main(page)).toContainText(t(lang).expired.body);
        await expect(page.getByTestId('pay-card-number')).toHaveCount(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `pay-expired-${lang}-${scheme}`);
      });

      test(`${lang} / ${scheme}: a link that is no longer valid`, async ({ page }, testInfo) => {
        await openPay(page, { lang, scheme, payments: { payView: 'notFound' } });
        await expect(page.locator('[data-final="invalid"]')).toBeVisible();
        await expect(main(page)).toContainText(t(lang).invalid.body);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `pay-invalid-${lang}-${scheme}`);
      });
    }
  }

  test('a token that dies reads "invalid" before expiresAt and "expired" after it', async ({
    page,
  }) => {
    const api = await openPay(page, { payments: { ttlSec: 9 } });
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    api.setPayView('notFound'); // cancelled elsewhere or replaced by a newer link
    await expect(page.locator('[data-final="invalid"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-final="expired"]')).toBeVisible({ timeout: 15_000 });
  });

  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: cancelled and invalid say what to do about money already sent`, async ({
      page,
    }, testInfo) => {
      const api = await openPay(page, { lang });
      await expect(page.getByTestId('pay-amount')).toBeVisible();
      api.setStatus('CANCELLED');
      await expect(page.locator('[data-final="cancelled"]')).toBeVisible({ timeout: 15_000 });
      await expect(main(page)).toContainText(t(lang).paidHelp);
      await shot(page, testInfo, `pay-cancelled-${lang}-light`);
    });
  }
});

test.describe('a finished request seen again', () => {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${lang} / ${scheme}: a neutral screen: finished, nothing of it shown, back to the bot`, async ({
        page,
      }, testInfo) => {
        const api = await openPay(page, { lang, scheme });
        await expect(page.getByTestId('pay-amount')).toBeVisible();
        api.setStatus('PAID');
        await expect(page.locator('[data-final="credited"]')).toBeVisible({ timeout: 15_000 });
        await page.reload();
        await expect(page.locator('[data-final="done"]')).toBeVisible();
        await expect(main(page)).toContainText(t(lang).done.title);
        await expect(main(page)).toContainText(t(lang).done.body);
        await expect(page.getByRole('link', { name: t(lang).cta.bot })).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        await shot(page, testInfo, `pay-done-${lang}-${scheme}`);
      });
    }
  }

  test('a cancelled request is finished too', async ({ page }) => {
    const api = await openPay(page);
    await expect(page.getByTestId('pay-amount')).toBeVisible();
    api.setStatus('CANCELLED');
    await expect(page.locator('[data-final="cancelled"]')).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.locator('[data-final="done"]')).toBeVisible();
  });

  test('without a support link configured, support leads to our own bot', async ({ page }) => {
    await openPay(page, { payments: { payView: 'notFound' } });
    await expect(page.locator('[data-final="invalid"]')).toBeVisible();
    await expect(page.getByRole('link', { name: t('uz').cta.support })).toHaveAttribute(
      'href',
      'https://t.me/ggpin_bot',
    );
  });
});

test.describe('a failing network', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: the last answer stays, marked "not updated", with a retry`, async ({
      page,
    }, testInfo) => {
      const api = await openPay(page, { lang });
      await expect(page.getByTestId('pay-amount')).toBeVisible();
      api.setPayView('error');
      const bar = page.getByRole('status').filter({ hasText: t(lang).netError });
      await expect(bar).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('pay-amount')).toBeVisible(); // still the last good figures
      await expect(page.getByText(t(lang).stale)).toBeVisible();
      await shot(page, testInfo, `pay-neterror-${lang}-light`);

      api.setPayView('ok');
      await bar.getByRole('button', { name: t(lang).retry }).click();
      await expect(bar).toHaveCount(0);
      await expect(page.getByText(t(lang).stale)).toHaveCount(0);
    });
  }

  test('no answer at all on the first load: an error with a retry', async ({ page }) => {
    const api = await openPay(page, { payments: { payView: 'error' } });
    await expect(page.getByRole('alert').filter({ hasText: t('uz').netError })).toBeVisible();
    api.setPayView('ok');
    await page.getByRole('button', { name: t('uz').retry }).click();
    await expect(page.getByTestId('pay-amount')).toBeVisible();
  });
});

test.describe('what the server sends with the page', () => {
  const check = (headers: Record<string, string | undefined>) => {
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-robots-tag']).toContain('noindex');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toMatch(/img-src 'self' data:(;|$)/);
    expect(csp).not.toContain('t.me');
    expect(csp).not.toContain('telegram.org');
    expect(/script-src ([^;]*)/.exec(csp)?.[1] ?? "'unsafe-inline'").not.toContain(
      "'unsafe-inline'",
    );
  };

  test('never cached, never indexed, no referrer, no frame, nothing from other origins', async ({
    page,
  }) => {
    await page.route('**/payments/**', (route) => route.fulfill({ status: 404, body: '{}' }));
    const response = await page.goto(`/pay/${INTENT_ID}?locale=uz`);
    check(response?.headers() ?? {});
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('exactly one Content-Security-Policy, also with a trailing slash', async ({ page }) => {
    await page.route('**/payments/**', (route) => route.fulfill({ status: 404, body: '{}' }));
    for (const path of [`/pay/${INTENT_ID}`, `/pay/${INTENT_ID}/`, '/pay/x/']) {
      const response = await page.goto(path);
      const all = (await response?.headersArray()) ?? [];
      expect(all.filter((h) => h.name.toLowerCase() === 'content-security-policy')).toHaveLength(1);
      check(response?.headers() ?? {});
    }
  });

  for (const query of ['?locale=ru&', '?locale=%72u']) {
    test(`${query} is Russian in the first HTML and in the text`, async ({ page }) => {
      await page.route('**/payments/**', (route) => route.fulfill({ status: 404, body: '{}' }));
      const response = await page.goto(`/pay/${INTENT_ID}${query}`);
      expect(await response?.text()).toMatch(/<html lang="ru"/);
      await expect(page.getByRole('radio', { name: 'RU' })).toBeChecked();
      await expect(main(page)).toContainText(t('ru').invalid.title);
    });
  }

  test('the first HTML already says the language of ?locale= in <html lang>', async ({ page }) => {
    await page.route('**/payments/**', (route) => route.fulfill({ status: 404, body: '{}' }));
    const response = await page.goto(`/pay/${INTENT_ID}?locale=ru`);
    expect(await response?.text()).toMatch(/<html lang="ru"/);
    const plain = await page.goto(`/pay/${INTENT_ID}`);
    expect(await plain?.text()).toMatch(/<html lang="uz"/);
  });
});
