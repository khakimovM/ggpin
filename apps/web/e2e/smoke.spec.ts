import AxeBuilder from '@axe-core/playwright';
import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test, type Page } from '@playwright/test';

// Records console errors and uncaught exceptions while a page loads.
function watchPage(page: Page) {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window as unknown as { __csp?: string[] };
    return store.__csp ?? [];
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const store = window as unknown as { __csp?: string[] };
    store.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
});

const PAGES = [
  { path: '/', lang: 'uz', text: uz.common.comingSoon },
  { path: '/ru', lang: 'ru', text: ru.common.comingSoon },
  { path: '/tg', lang: 'uz', text: uz.common.comingSoon },
];

test.describe('pages open without console or CSP errors', () => {
  for (const { path, lang, text } of PAGES) {
    test(`${path} (${lang})`, async ({ page }) => {
      const problems = watchPage(page);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.getByText(text)).toBeVisible();
      expect(await cspViolations(page)).toEqual([]);
      expect(problems).toEqual([]);
    });
  }
});

test('home page declares hreflang alternates for uz and ru', async ({ page }) => {
  await page.goto('/');
  const hrefLangs = await page
    .locator('link[rel="alternate"][hreflang]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('hreflang')));
  expect(hrefLangs).toEqual(expect.arrayContaining(['uz', 'ru']));
});

test.describe('accessibility (axe)', () => {
  for (const { path } of PAGES) {
    test(`${path} has no automatically detectable violations`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
