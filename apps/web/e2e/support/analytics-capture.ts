import type { Page, Request } from '@playwright/test';
import { FAKE_UMAMI_TRACKER } from './fake-umami';
import { untilHydrated } from './hydration';

// What the analytics specs (e2e/site/analytics*.spec.ts) share: the stand-in tracker served in
// place of /stats/script.js, the beacons it posts, and the requests a page makes to /stats/.

export const SCRIPT_PATH = '/stats/script.js';
export const COLLECT_PATH = '/stats/api/send';
export const SCRIPT_TAG = `script[src="${SCRIPT_PATH}"]`;
export const FILTER_NAME = 'ggpinAnalyticsBeforeSend';

const isStats = (request: Request) => new URL(request.url()).pathname.startsWith('/stats/');

/** Every request to /stats/ the page makes from now on. */
export function watchStats(page: Page) {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (isStats(request)) seen.push(new URL(request.url()).pathname);
  });
  return seen;
}

export interface Beacon {
  type: string;
  payload: Record<string, unknown>;
  raw: string;
}

/** Serves the stand-in tracker (or the given one) and records what it posts to the collector. */
export async function captureBeacons(page: Page, tracker = FAKE_UMAMI_TRACKER) {
  const beacons: Beacon[] = [];
  await page.route(`**${SCRIPT_PATH}`, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: tracker }),
  );
  await page.route(`**${COLLECT_PATH}`, async (route) => {
    const raw = route.request().postData() ?? '';
    const body = JSON.parse(raw) as Omit<Beacon, 'raw'>;
    beacons.push({ ...body, raw });
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  return beacons;
}

/**
 * The stand-in as a tracker older than Umami v3.0.0 behaves: it ignores data-exclude-search and
 * data-exclude-hash, so only our filter stands between the page URL and the beacon.
 */
export const TRACKER_IGNORING_EXCLUDE_FLAGS = FAKE_UMAMI_TRACKER.replace(
  "const excludeSearch = config('exclude-search') === 'true';",
  'const excludeSearch = false;',
).replace("const excludeHash = config('exclude-hash') === 'true';", 'const excludeHash = false;');

/** The page is hydrated (the shared predicate, e2e/support/hydration.ts). */
export const hydrated = (page: Page) => untilHydrated(page);

/** Marks the current document; a full page load starts a new one without the mark. */
export const markDocument = (page: Page) =>
  page.evaluate(() => Reflect.set(window, '__e2eSameDocument', true));
export const sameDocument = (page: Page) =>
  page.evaluate(() => Reflect.get(window, '__e2eSameDocument') === true);

/** Whether the tracker of the marketing pages is in this document: its tag and our filter. */
export const trackerState = (page: Page) =>
  page.evaluate(
    ({ tag, filter }) => ({
      tags: document.querySelectorAll(tag).length,
      filter: typeof Reflect.get(window, filter),
    }),
    { tag: SCRIPT_TAG, filter: FILTER_NAME },
  );

/** A client-side navigation by the app router itself (what a next/link click does). */
export const routerPush = (page: Page, href: string) =>
  page.evaluate((target) => {
    const next = Reflect.get(window, 'next') as { router: { push(to: string): void } };
    next.router.push(target);
  }, href);

/** The tracker waits 300 ms after a history change; a second is plenty for a beacon to show. */
export const BEACON_SETTLE_MS = 1_000;
