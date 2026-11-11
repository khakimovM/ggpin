import { expect, test } from '@playwright/test';

// From 768px a Sheet is a centred modal (max 480px wide) with a close button, not a bottom sheet.

test.describe('modal', () => {
  test('is centred, at most 480px wide, and closes from its close button', async ({ page }) => {
    await page.goto('/dev/ui');
    await page.getByRole('button', { name: 'Buyurtmani tasdiqlang' }).click();
    const dialog = page.getByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
    await expect(dialog).toBeVisible();

    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        const viewport = page.viewportSize();
        if (!box || !viewport) return null;
        return Math.round(box.x + box.width / 2 - viewport.width / 2);
      })
      .toBe(0);
    const box = await dialog.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(480);
    expect(box?.width).toBeGreaterThan(300);

    await dialog.getByRole('button', { name: 'Yopish' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('closes when the overlay is pressed', async ({ page }) => {
    await page.goto('/dev/ui');
    await page.getByRole('button', { name: 'Buyurtmani tasdiqlang' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
