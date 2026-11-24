import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { chooseTheme, seedMock, shotPath, type ThemeName } from './support/mock';

// S8b: the catalog editor on the mock API (plan §6.2). Writes go through the S7b dialog frame.
const REASON = 'Katalogni yangilash: S8b tekshiruvi';

async function open(page: Page, path: string, role: 'OWNER' | 'OPERATOR' = 'OWNER') {
  await seedMock(page, { signedIn: true, role });
  await page.goto(path);
}

function rowNames(page: Page) {
  return page.getByRole('list', { name: 'Mahsulotlar' }).getByRole('listitem').getByRole('link');
}

interface Journal {
  audit: { action: string; targetId: string; reason: string | null }[];
  catalog: { products: Record<string, object>; skus: Record<string, object> };
}

/** The mock API's write journal (sessionStorage): what the writes changed, and their audit rows. */
async function journal(page: Page): Promise<Journal> {
  const raw = await page.evaluate(() => window.sessionStorage.getItem('ggpin-admin-mock-writes'));
  return JSON.parse(raw ?? '{}') as Journal;
}

test('reorder with the keyboard (Alt+↓) and the arrow buttons, then save without a reason', async ({
  page,
}) => {
  await open(page, '/products');
  await expect(rowNames(page).first()).toHaveText('Telegram Stars');
  const first = page.locator('#product-row-mkprod000001');
  await first.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(rowNames(page).nth(1)).toHaveText('Telegram Stars');
  await expect(page.locator('#product-row-mkprod000001')).toBeFocused();
  await page.getByRole('button', { name: 'Roblox: yuqoriga' }).click();
  await expect(rowNames(page).nth(4)).toHaveText('Roblox');
  await expect(page.getByText('Tartib o‘zgardi, hali saqlanmagan')).toBeVisible();

  await page.getByRole('button', { name: 'Tartibni saqlash' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mahsulotlar tartibini saqlash' });
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
  await page.reload();
  await expect(rowNames(page).first()).toHaveText('Telegram Premium');
  await expect(rowNames(page).nth(4)).toHaveText('Roblox');
});

test('reorder by dragging a row onto another', async ({ page }) => {
  await open(page, '/products');
  await page.locator('#product-row-mkprod000006').dragTo(page.locator('#product-row-mkprod000001'));
  await expect(rowNames(page).first()).toHaveText('Roblox');
  await page.getByRole('button', { name: 'Bekor qilish' }).click();
  await expect(rowNames(page).first()).toHaveText('Telegram Stars');
});

test('the switch turns a product off after a reason', async ({ page }) => {
  await open(page, '/products');
  await page.getByRole('switch', { name: 'Roblox: katalogda faol' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mahsulotni o‘chirish' });
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'O‘chirish' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('switch', { name: 'Roblox: katalogda faol' })).not.toBeChecked();
});

test('editor: RU tab, only the changed field is sent, a double click sends once', async ({
  page,
}) => {
  await open(page, '/products/mkprod000001');
  await page.getByRole('tab', { name: 'Ruscha' }).click();
  await page.getByRole('textbox', { name: 'Nomi' }).fill('Звёзды Telegram');
  await expect(page.getByText('1 ta maydon o‘zgardi')).toBeVisible();
  await page.getByRole('button', { name: 'Saqlash' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mahsulotni saqlash' });
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Saqlash' }).dblclick();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
  const after = await journal(page);
  expect(after.catalog.products.mkprod000001).toEqual({ nameRu: 'Звёзды Telegram' });
  expect(after.audit.filter((row) => row.targetId === 'mkprod000001')).toHaveLength(1);
});

test('SKU dialog: percent to bps, live price, quantity warning', async ({ page }) => {
  await open(page, '/products/mkprod000001');
  await page.getByRole('button', { name: '100 ⭐: tahrirlash' }).click();
  const dialog = page.getByRole('dialog', { name: 'SKUʼni tahrirlash' });
  await dialog.getByRole('textbox', { name: 'Ustama' }).fill('12,5');
  await expect(dialog.getByText('Jonli narx · saqlanmagan qiymatlar bilan')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Miqdor' }).fill('120');
  await expect(dialog.getByText(/Miqdor o‘zgarmoqda/)).toBeVisible();
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(dialog).toBeHidden();
  expect((await journal(page)).catalog.skus.mksku000002).toEqual({
    markupBps: 1250,
    quantity: 120,
  });
  // A new quantity has no cost yet: the saved package shows no price until the next sync.
  await page.goto('/products/mkprod000001?sku=mksku000002');
  await expect(page.getByText(/Narxni hisoblab bo‘lmadi/)).toBeVisible();
});

test('a duplicate package is named, not "unknown"', async ({ page }) => {
  await open(page, '/products/mkprod000001');
  await page.getByRole('button', { name: 'SKU qo‘shish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Yangi SKU' });
  await dialog.getByRole('textbox', { name: 'Nomi (uz)' }).fill('50 ⭐');
  await dialog.getByRole('textbox', { name: 'Nomi (ru)' }).fill('50 ⭐');
  await dialog.getByRole('textbox', { name: 'Miqdor' }).fill('50');
  await dialog.getByRole('textbox', { name: 'Ustama' }).fill('10');
  await dialog.getByRole('textbox', { name: 'Min marja' }).fill('1 000');
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Qo‘shish' }).click();
  await expect(dialog.getByText('Shu miqdorli faol paket allaqachon bor')).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('OPERATOR reads the catalog only', async ({ page }) => {
  await open(page, '/products', 'OPERATOR');
  await expect(rowNames(page).first()).toHaveText('Telegram Stars');
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /yuqoriga|pastga/ })).toHaveCount(0);
  await page.goto('/products/mkprod000001');
  await expect(page.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Ruscha' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /tahrirlash|sozlash|SKU qo‘shish/ })).toHaveCount(
    0,
  );
});

for (const theme of ['light', 'dark'] as ThemeName[]) {
  test(`catalog shots and axe, ${theme}`, async ({ page }, testInfo) => {
    // Three pages, three axe runs and three full-page shots.
    test.setTimeout(120_000);
    await chooseTheme(page, theme);
    await open(page, '/products');
    await expect(rowNames(page).first()).toHaveText('Telegram Stars');
    await page.screenshot({
      path: shotPath(`s8b-products-${testInfo.project.name}-${theme}`),
      fullPage: true,
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.goto('/products/mkprod000001?sku=mksku000006');
    await expect(page.getByText('Marja minimaldan past').first()).toBeVisible();
    await page.screenshot({
      path: shotPath(`s8b-product-${testInfo.project.name}-${theme}`),
      fullPage: true,
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.getByRole('button', { name: '2500 ⭐: tahrirlash' }).click();
    const dialog = page.getByRole('dialog', { name: 'SKUʼni tahrirlash' });
    await dialog.getByRole('textbox', { name: 'Ustama' }).fill('15');
    await expect(dialog.getByText('Jonli narx · saqlanmagan qiymatlar bilan')).toBeVisible();
    await page.screenshot({ path: shotPath(`s8b-sku-dialog-${testInfo.project.name}-${theme}`) });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
