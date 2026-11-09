import type { Locator, Page } from '@playwright/test';

// Shared by layout.spec.ts and layout-pages.spec.ts (phase 7 S10): the width buckets (phone < 768,
// tablet 768-1023, desktop >= 1024) and the measuring helper.

export const width = (page: Page) => page.viewportSize()?.width ?? 0;
export const phone = (page: Page) => width(page) < 768;
export const desktop = (page: Page) => width(page) >= 1024;
export const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('not laid out');
  return found;
};
export const HEADER_ROW = 72;
