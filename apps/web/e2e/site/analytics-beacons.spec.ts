import { expect, test } from '@playwright/test';
import {
  BEACON_SETTLE_MS,
  captureBeacons,
  hydrated,
  markDocument,
  routerPush,
  sameDocument,
  SCRIPT_TAG,
  TRACKER_IGNORING_EXCLUDE_FLAGS,
  type Beacon,
} from '../support/analytics-capture';
import { E2E_ANALYTICS_SITE_ID } from '../support/app-env';
import { FAKE_UMAMI_TRACKER } from '../support/fake-umami';

// What an analytics beacon carries (phase 8 S5): origin + path of a marketing page, a referrer
// that is a marketing page of ours or only the origin of an outside site, and nothing from the
// store, the login or the account pages. The site's own links leave the marketing pages with a
// full page load, so the tracker does not follow into those pages.

// A navigation renders a dynamic page on the server (the landing waits for the catalog, a store page
// for its data): on a loaded machine that takes longer than the default 5 s of an assertion.
const SOFT_NAV_MS = 20_000;

const ORDER_ID = 'cm3analyticsorder000000001';

// The referrer of a page view after a bare history.pushState from `/` to `/faq`. The tracker reads
// it when it sends, 300 ms later, and the app router has meanwhile echoed the change with a
// replaceState of the new URL, so the tracker may report the new page as its own referrer. Both
// are marketing paths without query or hash, which is all this spec is about.
const MARKETING_REFERRERS = ['/', '/faq'];

function expectNothingSecret(beacons: readonly Beacon[]) {
  for (const beacon of beacons) {
    expect(beacon.raw).not.toContain('?');
    expect(beacon.raw).not.toContain('#');
    expect(beacon.raw).not.toContain('t=');
    expect(beacon.raw).not.toContain('secret');
    expect(beacon.raw).not.toContain('login');
    expect(beacon.raw).not.toContain('store');
    expect(beacon.raw).not.toContain(ORDER_ID);
    expect(Object.keys(beacon.payload).sort()).toEqual(
      ['hostname', 'language', 'referrer', 'screen', 'title', 'url', 'website'].sort(),
    );
  }
}

test.describe('what a beacon carries', () => {
  // Several navigations and beacon waits per test: triple the time of a single page view.
  test.slow();

  test('no query, no hash, no t=, and an outside referrer as its origin only', async ({
    page,
    baseURL,
  }) => {
    const beacons = await captureBeacons(page);
    await page.goto('/faq?utm_source=tg&t=abc#t=secret', {
      referer: 'https://search.example/find?q=ggpin&t=1#t=2',
    });
    await hydrated(page);
    await expect.poll(() => beacons.length).toBe(1);
    expect(beacons[0]?.type).toBe('event');
    expect(beacons[0]?.payload).toEqual({
      website: E2E_ANALYTICS_SITE_ID,
      screen: expect.any(String),
      language: expect.any(String),
      title: expect.any(String),
      hostname: 'localhost',
      url: `${baseURL}/faq`,
      referrer: 'https://search.example',
    });

    // A client-side navigation to another marketing page (the header logo): its referrer is the
    // previous marketing page, as a path. Still the same document: a client-side move.
    await markDocument(page);
    await page.locator('header a[href="/"]').first().click();
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: SOFT_NAV_MS });
    expect(await sameDocument(page)).toBe(true);
    await expect.poll(() => beacons.length).toBe(2);
    expect(beacons[1]?.payload).toMatchObject({ url: `${baseURL}/`, referrer: '/faq' });

    // A history change to a marketing page with a query and a token-like hash: path only.
    await page.evaluate(() => window.history.pushState(null, '', '/faq?x=1#t=secret'));
    await expect.poll(() => beacons.length).toBe(3);
    expect(beacons[2]?.payload.url).toBe(`${baseURL}/faq`);
    expect(MARKETING_REFERRERS).toContain(beacons[2]?.payload.referrer);
    expectNothingSecret(beacons);
  });

  test('even a tracker that ignores the exclude flags (Umami < v3) sends no query or hash', async ({
    page,
    baseURL,
  }) => {
    expect(TRACKER_IGNORING_EXCLUDE_FLAGS).not.toBe(FAKE_UMAMI_TRACKER);
    const beacons = await captureBeacons(page, TRACKER_IGNORING_EXCLUDE_FLAGS);
    await page.goto('/?utm_source=tg&t=abc#t=secret', {
      referer: 'https://search.example/find?q=ggpin#t=2',
    });
    await hydrated(page);
    await expect.poll(() => beacons.length).toBe(1);
    await page.evaluate(() => window.history.pushState(null, '', '/faq?x=1#t=secret'));
    await expect.poll(() => beacons.length).toBe(2);
    expect(beacons.map((beacon) => beacon.payload.url)).toEqual([`${baseURL}/`, `${baseURL}/faq`]);
    expect(beacons[0]?.payload.referrer).toBe('https://search.example');
    expect(MARKETING_REFERRERS).toContain(beacons[1]?.payload.referrer);
    expectNothingSecret(beacons);
  });

  for (const [what, privatePath] of [
    ['the login', '/login'],
    ['an order page', `/store/orders/${ORDER_ID}`],
  ] as const) {
    test(`a client-side detour through ${what}: no beacon for it, and an empty referrer after it`, async ({
      page,
      baseURL,
    }) => {
      const beacons = await captureBeacons(page);
      await page.goto('/faq');
      await hydrated(page);
      await expect.poll(() => beacons.length).toBe(1);

      // The app router itself (not a link of ours, which loads the page anew): the tracker is
      // still in the window and sees the history change.
      await markDocument(page);
      await routerPush(page, privatePath);
      await expect(page).not.toHaveURL(`${baseURL}/faq`, { timeout: SOFT_NAV_MS });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(BEACON_SETTLE_MS);
      expect(beacons).toHaveLength(1);

      // Back to a marketing page: the third page view is sent, but its referrer would be the
      // private page, so it is empty. A push while the private page is still settling can be
      // dropped by the router (seen once at 768 px on a loaded machine), so it is repeated until
      // the URL follows; a repeat to the same URL is no new page view for the tracker.
      await expect(async () => {
        await routerPush(page, '/');
        await expect(page).toHaveURL(`${baseURL}/`, { timeout: 5_000 });
      }).toPass({ timeout: 45_000 });
      // Still the document the tracker was loaded in: the detour was client-side all along.
      expect(await sameDocument(page)).toBe(true);
      await expect.poll(() => beacons.length).toBe(2);
      expect(beacons[1]?.payload).toMatchObject({ url: `${baseURL}/`, referrer: '' });
      expectNothingSecret(beacons);
    });
  }
});

test.describe('leaving the marketing pages', () => {
  test.slow();

  test('the header sign-in is a full page load: the login has no tracker, and sends nothing', async ({
    page,
    baseURL,
  }) => {
    const beacons = await captureBeacons(page);
    await page.goto('/faq');
    await hydrated(page);
    await expect.poll(() => beacons.length).toBe(1);
    await markDocument(page);

    const documentLoad = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.resourceType() === 'document' &&
        new URL(request.url()).pathname === '/login',
    );
    await page.locator('a[href="/login"]:visible').first().click();
    await documentLoad;
    await expect(page).toHaveURL(`${baseURL}/login`, { timeout: SOFT_NAV_MS });
    await hydrated(page);

    expect(await sameDocument(page)).toBe(false);
    const navigation = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation');
      return entry === undefined ? null : new URL(entry.name).pathname;
    });
    expect(navigation).toBe('/login');
    await expect(page.locator(SCRIPT_TAG)).toHaveCount(0);
    expect(await page.evaluate(() => typeof Reflect.get(window, 'ggpinAnalyticsBeforeSend'))).toBe(
      'undefined',
    );

    // Whatever the login page does with its history, nothing listens any more.
    await page.evaluate(() => window.history.pushState(null, '', '/login?next=%2Fstore#t=secret'));
    await page.waitForTimeout(BEACON_SETTLE_MS);
    expect(beacons).toHaveLength(1);
  });

  for (const [lang, landing, store] of [
    ['uz', '/', '/store'],
    ['ru', '/ru', '/ru/store'],
  ] as const) {
    test(`${lang}: the landing's store button is a full page load to ${store}`, async ({
      page,
    }) => {
      await captureBeacons(page);
      await page.goto(landing);
      await hydrated(page);
      await markDocument(page);
      const documentLoad = page.waitForRequest(
        (request) =>
          request.isNavigationRequest() &&
          request.resourceType() === 'document' &&
          new URL(request.url()).pathname === store,
      );
      await page.getByRole('main').locator(`a[href="${store}"]`).first().click();
      await documentLoad;
      await page.waitForLoadState('domcontentloaded');
      expect(await sameDocument(page)).toBe(false);
      await expect(page.locator(SCRIPT_TAG)).toHaveCount(0);
    });
  }
});
