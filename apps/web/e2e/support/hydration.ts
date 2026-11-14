import type { Page } from '@playwright/test';

/**
 * Waits until React has hydrated the page: the element found by `selector` carries React's props
 * (React sets them on every element it hydrates or renders). The theme attribute is no sign of it:
 * the inline theme script sets it before any React code runs. A click before hydration is lost,
 * and a client-side navigation needs the app router, which hydrates before the page under it.
 * One predicate for every spec (journey 1, the analytics specs).
 */
export async function untilHydrated(page: Page, selector = 'main', timeout = 15_000) {
  await page.waitForFunction(
    (target) => {
      const element = document.querySelector(target);
      return element !== null && Object.keys(element).some((key) => key.startsWith('__reactProps'));
    },
    selector,
    { timeout },
  );
}
