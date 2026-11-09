import { expect, test } from '@playwright/test';
import { tgCallNames, tgCalls } from '../fixtures/telegram';
import { SCHEMES, account, attachShot, openAccount, type Lang } from './account-support';
import { axeViolations, overflow } from './support';

// The Mini App referral and help screens, and every account screen in both languages and themes
// (phase 7 S9).

const rowsOf = (page: import('@playwright/test').Page) =>
  page.getByRole('tabpanel').getByRole('link');

test.describe('referral and help', () => {
  test('the link comes from the bot in env and the code of the user; copy and share', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openAccount(page, '/tg/referral');
    const t = account('uz').referral;
    await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    await expect(page.getByText(/t\.me\/[A-Za-z0-9_]+\?startapp=ref_ref12345/)).toBeVisible();
    await page.getByRole('button', { name: t.copy }).click();
    await expect(page.getByText(t.copied)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /^https:\/\/t\.me\/[A-Za-z0-9_]+\?startapp=ref_ref12345$/,
    );
    await page.getByRole('button', { name: t.share }).click();
    // The call is recorded by the page, not awaited by the click: poll for it.
    await expect
      .poll(async () => {
        const share = (await tgCalls(page)).find(([name]) => name === 'openTelegramLink');
        const url = share?.[1];
        return typeof url === 'string' ? url : '';
      })
      .toContain('https://t.me/share/url?url=');
    const stats = page.locator('section').filter({ hasText: t.stats.title });
    await expect(stats.getByText(t.soon, { exact: true })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('the BackButton is shown on the referral screen', async ({ page }) => {
    await openAccount(page, '/tg/referral');
    await expect.poll(async () => tgCallNames(page)).toContain('BackButton.show');
  });

  test('help: one answer open at a time; without a support link the card says so', async ({
    page,
  }, testInfo) => {
    await openAccount(page, '/tg/help');
    const t = account('uz').help;
    await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    const first = page.getByRole('button', { name: t.faq.q1 });
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: t.faq.q5 }).click();
    await expect(page.getByRole('button', { name: t.faq.q5 })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText(t.ask.hours)).toBeVisible();
    await expect(page.getByText(t.ask.unavailable)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await attachShot(page, testInfo, 'help-uz-light');
  });
});

const LANGS: Lang[] = ['uz', 'ru'];
const PATHS = ['/tg/history', '/tg/profile', '/tg/referral', '/tg/help'] as const;
for (const lang of LANGS) {
  for (const scheme of SCHEMES) {
    test.describe(`${lang} / ${scheme}`, () => {
      for (const path of PATHS) {
        test(`${path}: fits, no axe violation`, async ({ page }, testInfo) => {
          await openAccount(page, path, { lang, scheme });
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          if (path === '/tg/history') await expect(rowsOf(page).first()).toBeVisible();
          if (path === '/tg/profile') await expect(page.getByText('@sardor_r')).toBeVisible();
          expect(await overflow(page)).toBeLessThanOrEqual(0);
          expect(await axeViolations(page)).toEqual([]);
          await attachShot(page, testInfo, `${path.slice(4)}-${lang}-${scheme}`);
        });
      }
    });
  }
}
