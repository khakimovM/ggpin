import { expect, type Locator, type Page } from '@playwright/test';

export const SECTIONS = [
  'foundations',
  'actions',
  'inputs',
  'selection',
  'containers',
  'states',
] as const;
export const THEMES = ['light', 'dark'] as const;
export const LANGS = ['uz', 'ru'] as const;

// A control passes when every edge of its 44 x 44 target answers to it: the visual box may be
// smaller (sm button, chip, switch), but a pseudo-element grows the area that takes the tap.
export async function expectHitArea44(locator: Locator) {
  await locator.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  const misses = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const width = Math.max(rect.width, 44);
    const height = Math.max(rect.height, 44);
    const growX = (width - rect.width) / 2;
    const growY = (height - rect.height) / 2;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const probes: [string, number, number][] = [
      ['top', cx, rect.top - growY + 1],
      ['bottom', cx, rect.bottom + growY - 1],
      ['left', rect.left - growX + 1, cy],
      ['right', rect.right + growX - 1, cy],
    ];
    return probes
      .filter(([, x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !hit || !(node === hit || node.contains(hit));
      })
      .map(([edge]) => edge);
  });
  expect(misses).toEqual([]);
}

export function watchPage(page: Page) {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

export async function openGallery(
  page: Page,
  theme: (typeof THEMES)[number],
  lang: (typeof LANGS)[number],
) {
  // The theme is remembered in localStorage, which is how a returning visitor gets dark mode.
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), theme);
  await page.goto('/dev/ui');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, {
    timeout: 15_000, // cold WebKit hydrates slowly when workers compete for the CPU
  });
  if (lang === 'ru') {
    await page.getByRole('radio', { name: 'Русский' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  }
}
