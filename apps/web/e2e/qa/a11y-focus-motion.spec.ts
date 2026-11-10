import { expect, test } from '@playwright/test';
import { focusIsVisible, settle } from './qa-support';
import { MINI } from './screens-mini';
import { WEB } from './screens-web';

// Phase 7 S11, check 3 (continued), on every screen of the matrix. These two sweeps are slow (one
// full page load per screen), so they run only with the QA config (README.md), not in the ordinary
// suite:
//  - prefers-reduced-motion: nothing loops (a finite fade is allowed), whatever the screen;
//  - keyboard focus is visible on every Tab stop.

test.describe('prefers-reduced-motion: nothing loops', () => {
  test.use({ reducedMotion: 'reduce' });
  for (const screen of [...MINI, ...WEB]) {
    test(`${screen.name}`, async ({ page }) => {
      await screen.open({ page, lang: 'uz', scheme: 'light' });
      await settle(page);
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      ).toBe(true);
      const looping = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations === Infinity)
          .map((a) => (a instanceof CSSAnimation ? a.animationName : a.id || 'animation')),
      );
      expect(looping).toEqual([]);
    });
  }
});

test.describe('keyboard focus is visible on every Tab stop', () => {
  for (const screen of [...MINI, ...WEB]) {
    test(`${screen.name} uz/light`, async ({ page }) => {
      await screen.open({ page, lang: 'uz', scheme: 'light' });
      await settle(page);
      const unseen: string[] = [];
      for (let step = 0; step < 40; step += 1) {
        await page.keyboard.press('Tab');
        const miss = await focusIsVisible(page);
        if (miss !== null) unseen.push(miss);
      }
      expect(unseen, 'focus stops without an outline or ring').toEqual([]);
    });
  }
});
