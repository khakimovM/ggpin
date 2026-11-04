import { expect, test } from '@playwright/test';

// Utilities must beat the element rules in tokens.css and resolve to the handoff values.
test.describe('token utilities (computed style)', () => {
  test('light theme', async ({ page }) => {
    await page.goto('/e2e-probe');
    const button = page.getByTestId('probe-button');
    await expect(button).toHaveCSS('background-color', 'rgb(61, 75, 245)');
    await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(button).toHaveCSS('font-size', '14px');
    await expect(button).toHaveCSS('font-weight', '600');
    await expect(button).toHaveCSS('border-radius', '20px');
    await expect(button).toHaveCSS('transition-duration', '0.14s');
    await expect(page.getByTestId('probe-link')).toHaveCSS('color', 'rgb(63, 72, 99)');
  });

  test('shadow-md composes with ring-2 instead of being replaced', async ({ page }) => {
    await page.goto('/e2e-probe');
    const shadow = await page
      .getByTestId('probe-button')
      .evaluate((element) => getComputedStyle(element).boxShadow);
    expect(shadow).toContain('rgb(61, 75, 245) 0px 0px 0px 2px');
    expect(shadow).toContain('0px 6px 16px -4px');
  });

  test('dark theme switches the same utilities through data-theme', async ({ page }) => {
    await page.goto('/e2e-probe');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    const button = page.getByTestId('probe-button');
    await expect(button).toHaveCSS('background-color', 'rgb(74, 87, 255)');
    await expect(page.getByTestId('probe-link')).toHaveCSS('color', 'rgb(183, 191, 218)');
  });
});
