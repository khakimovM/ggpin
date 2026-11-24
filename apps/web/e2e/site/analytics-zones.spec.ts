import { expect, test } from '@playwright/test';
import {
  captureBeacons,
  hydrated,
  markDocument,
  routerPush,
  SCRIPT_TAG,
  sameDocument,
  trackerState,
} from '../support/analytics-capture';
import { openStore, prefix, TEXT } from '../store/catalog-support';

// The way back from the store to the site (phase 8 S5, re-review P1): the store footer's offer is a
// marketing page, so the link loads it anew. The site's tracker is then only ever in the offer's
// document: Back returns to a store document that never had it, and the store stays without it as
// the visitor moves on inside it (a client-side move to the orders).

// A navigation renders a page on the server (the store's data, the offer): on a loaded machine
// that takes longer than the default 5 s of an assertion.
const NAV_MS = 20_000;

const NO_TRACKER = { tags: 0, filter: 'undefined' };

for (const lang of ['uz', 'ru'] as const) {
  test(`${lang}: store → the footer's offer → Back: the tracker never enters the store's document`, async ({
    page,
    baseURL,
  }) => {
    // Three page loads, a Back and a client-side move, each waited for.
    test.slow();
    const beacons = await captureBeacons(page);
    const store = `${prefix(lang)}/store`;
    const terms = `${prefix(lang)}/terms`;
    await openStore(page, { lang });
    await hydrated(page);
    const offer = page
      .getByRole('contentinfo')
      .getByRole('link', { name: TEXT[lang].web.footer.terms });
    await expect(offer).toHaveAttribute('href', terms, { timeout: NAV_MS });
    expect(await trackerState(page)).toEqual(NO_TRACKER);
    await markDocument(page);

    // The offer: a new document, which has the tracker and sends its page view. (A client-side
    // move would fetch no document: the wait fails, as it did for the store's old next/link.)
    const documentLoad = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.resourceType() === 'document' &&
        new URL(request.url()).pathname === terms,
      { timeout: NAV_MS },
    );
    await offer.click();
    await documentLoad;
    await expect(page).toHaveURL(`${baseURL}${terms}`, { timeout: NAV_MS });
    await expect(page.locator(SCRIPT_TAG)).toHaveCount(1, { timeout: NAV_MS });
    expect(await sameDocument(page)).toBe(false);
    await expect.poll(() => beacons.length, { timeout: NAV_MS }).toBe(1);
    expect(beacons[0]?.payload.url).toBe(`${baseURL}${terms}`);

    // Back: the store again, without the tracker or its filter.
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}${store}`, { timeout: NAV_MS });
    await hydrated(page);
    await expect(offer).toBeVisible({ timeout: NAV_MS });
    expect(await trackerState(page)).toEqual(NO_TRACKER);

    // On inside the store, client-side: still nothing.
    await markDocument(page);
    await routerPush(page, `${store}/orders`);
    await expect(page).toHaveURL(`${baseURL}${store}/orders`, { timeout: NAV_MS });
    expect(await sameDocument(page)).toBe(true);
    expect(await trackerState(page)).toEqual(NO_TRACKER);
    expect(beacons).toHaveLength(1);
  });
}
