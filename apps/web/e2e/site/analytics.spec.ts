import { expect, test } from '@playwright/test';
import { SITE_PAGES } from '../../src/features/site/seo/site-pages';
import {
  BEACON_SETTLE_MS,
  captureBeacons,
  FILTER_NAME,
  hydrated,
  SCRIPT_TAG,
  SCRIPT_PATH,
  watchStats,
} from '../support/analytics-capture';
import { E2E_ANALYTICS_SITE_ID } from '../support/app-env';
import { stubTelegramSdk } from '../fixtures/telegram';

// Analytics (phase 8 S5, D-08/D-57): the Umami tag is on the marketing pages and nowhere else, it
// is drawn only once our beacon filter is in place, and it leaves no cookie and talks to no other
// origin. What a beacon carries: analytics-beacons.spec.ts. The e2e build has a website id
// (playwright.config.ts); without one nothing renders (SiteAnalytics.test.tsx, the Lighthouse build).

const localised = (path: string, lang: 'uz' | 'ru') =>
  lang === 'uz' ? path : path === '/' ? '/ru' : `/ru${path}`;

test.describe('where the tag is', () => {
  for (const lang of ['uz', 'ru'] as const) {
    test(`${lang}: every marketing page has one Umami tag with the privacy flags`, async ({
      page,
    }) => {
      // Seven full page loads in one test: triple the time a single page view gets.
      test.slow();
      for (const { path } of SITE_PAGES) {
        const url = localised(path, lang);
        const stats = watchStats(page);
        await page.goto(url);
        await hydrated(page);
        const tag = page.locator(SCRIPT_TAG);
        await expect(tag, url).toHaveCount(1);
        await expect(tag).toHaveAttribute('data-website-id', E2E_ANALYTICS_SITE_ID);
        await expect(tag).toHaveAttribute('data-exclude-search', 'true');
        await expect(tag).toHaveAttribute('data-exclude-hash', 'true');
        await expect(tag).toHaveAttribute('data-do-not-track', 'true');
        await expect(tag).toHaveAttribute('data-before-send', FILTER_NAME);
        await expect.poll(() => stats, { message: url }).toContain(SCRIPT_PATH);
      }
    });
  }

  for (const path of [
    '/login',
    '/ru/login',
    '/store',
    '/ru/store',
    '/tg',
    '/pay/cm3analytics0000000000001',
  ]) {
    test(`${path}: no tag and no request to /stats/`, async ({ page }) => {
      await stubTelegramSdk(page);
      const stats = watchStats(page);
      await page.goto(path);
      await hydrated(page);
      await page.waitForLoadState('networkidle');
      await expect(page.locator(SCRIPT_TAG)).toHaveCount(0);
      expect(stats).toEqual([]);
    });
  }
});

test.describe('fail-closed', () => {
  for (const kind of ['img', 'form'] as const) {
    test(`an injected <${kind}> that takes the filter's name: no tracker is loaded, no beacon is sent`, async ({
      page,
    }) => {
      // Stands in for an HTML injection of one element (no script needed): an <img id> is reached
      // as window[id], a <form name> as window[name], before our filter could be installed.
      await page.addInitScript(
        ({ name, tag }) => {
          const add = () => {
            if (!document.head) return false;
            const element = document.createElement(tag);
            if (tag === 'img') element.id = name;
            else element.setAttribute('name', name);
            // In <head>, where React 19 leaves foreign nodes alone during hydration.
            document.head.appendChild(element);
            return true;
          };
          if (add()) return;
          const observer = new MutationObserver(() => {
            if (add()) observer.disconnect();
          });
          observer.observe(document, { childList: true, subtree: true });
        },
        { name: FILTER_NAME, tag: kind },
      );
      const beacons = await captureBeacons(page);
      const stats = watchStats(page);
      await page.goto('/faq');
      await hydrated(page);
      await page.waitForLoadState('networkidle');
      // The name is taken by the element, not by our filter: nothing was installed over it.
      expect(await page.evaluate((name) => typeof Reflect.get(window, name), FILTER_NAME)).toBe(
        'object',
      );
      await page.evaluate(() => window.history.pushState(null, '', '/login'));
      await page.waitForTimeout(BEACON_SETTLE_MS);
      await expect(page.locator(SCRIPT_TAG)).toHaveCount(0);
      expect(stats).toEqual([]);
      expect(beacons).toEqual([]);
    });
  }
});

test.describe('privacy of the requests', () => {
  test('a marketing visit with the tracker sets no cookie and asks no other origin', async ({
    page,
    context,
    baseURL,
  }) => {
    if (baseURL === undefined) throw new Error('baseURL is set in playwright.config.ts');
    const origins = new Set<string>();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    });
    const beacons = await captureBeacons(page);
    expect(await context.cookies()).toEqual([]);

    await page.goto('/telegram-stars');
    await hydrated(page);
    await expect.poll(() => beacons.length).toBe(1);
    await page.locator('header a[href="/"]').first().click();
    await expect.poll(() => beacons.length).toBe(2);
    await page.waitForLoadState('networkidle');

    // Nothing in the browser holds a cookie of ours: not the pages, not the tracker, not the beacon.
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    // Every request of the page (documents, scripts, styles, fonts, images, the tracker, the
    // beacons) went to our own origin.
    expect([...origins]).toEqual([baseURL]);
  });
});
