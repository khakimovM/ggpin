import { expect, test, type Page } from '@playwright/test';

// Below 768px a Sheet is a bottom sheet: it slides up from the bottom edge and a drag down on
// its handle dismisses it (> 80px or fast enough). Runs in the 375 / 390 / WebKit projects.

async function openSheet(page: Page) {
  await page.goto('/dev/ui');
  await page.getByRole('button', { name: 'Buyurtmani tasdiqlang' }).click();
  const dialog = page.getByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
  await expect(dialog).toBeVisible();
  // wait for the spring to settle at the bottom edge
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      return box && viewport ? Math.round(viewport.height - (box.y + box.height)) : null;
    })
    .toBe(0);
  return dialog;
}

test.describe('bottom sheet', () => {
  test('is anchored to the bottom edge and spans the width', async ({ page }) => {
    const dialog = await openSheet(page);
    const box = await dialog.boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBe(page.viewportSize()?.width);
  });

  test('a drag down of more than 80px on the handle dismisses it', async ({ page }) => {
    const dialog = await openSheet(page);
    const box = await dialog.boundingBox();
    if (!box) throw new Error('sheet has no box');
    const x = box.x + box.width / 2;
    const y = box.y + 10;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 60, { steps: 6 });
    await page.mouse.move(x, y + 160, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a short drag (under 80px) springs back and keeps it open', async ({ page }) => {
    const dialog = await openSheet(page);
    const box = await dialog.boundingBox();
    if (!box) throw new Error('sheet has no box');
    const x = box.x + box.width / 2;
    const y = box.y + 10;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 30, { steps: 6 });
    await page.waitForTimeout(250); // slow release: no fling velocity
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    await expect
      .poll(async () => {
        const settled = await dialog.boundingBox();
        return settled ? Math.round(settled.y - box.y) : null;
      })
      .toBe(0);
  });

  test('pressing the overlay above the sheet closes it', async ({ page }) => {
    await openSheet(page);
    await page.mouse.click(180, 20);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
