import type { Page } from '@playwright/test';

/**
 * Fonts loaded and every finite animation finished (entrance, slide, pop); the loops (pulse,
 * gradient drift, the floating cards) are left running. A contrast check or a screenshot must not
 * read a frame in which a card is half transparent, and there is no fixed sleep. A finite animation
 * that never ends must not hang a run: after 3 s the wait gives up.
 */
export async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  });
}
