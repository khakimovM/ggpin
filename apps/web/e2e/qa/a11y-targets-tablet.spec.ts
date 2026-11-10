import { expect, test } from '@playwright/test';
import { settle } from './qa-support';
import { TOUCH_MIN, targetProblems } from './qa-targets';
import { WEB } from './screens-web';

// A tablet: 1024 px wide (desktop layout) with a coarse pointer. The CSS turns `--hit-min` to 44 px
// on `(pointer: coarse)` whatever the width, so the text links of the header, the footer and the
// breadcrumb must reach 44 x 44 here, and the bigger areas must still not overlap. The viewport
// width alone (a11y-targets.spec.ts) never takes that branch. The config runs this file in the
// w1440 project only.

test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

for (const name of ['store-catalog', 'store-product-stars', 'store-history']) {
  test(`${name}: coarse pointer at 1024 px, every control 44 x 44, no overlap`, async ({
    page,
  }) => {
    const screen = WEB.find((candidate) => candidate.name === name);
    if (screen === undefined) throw new Error(`no screen ${name}`);
    await screen.open({ page, lang: 'uz', scheme: 'light' });
    await settle(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--hit-min'),
      ),
    ).toBe('44px');
    const { small, overlaps, covered } = await targetProblems(page, TOUCH_MIN);
    expect(small.map((x) => `${x.what} ${x.width}x${x.height}`)).toEqual([]);
    expect(overlaps).toEqual([]);
    expect(covered).toEqual([]);
  });
}
