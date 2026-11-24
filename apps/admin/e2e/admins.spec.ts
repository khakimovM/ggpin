import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MOCK_CODE, chooseTheme, seedMock, shotPath, type ThemeName } from './support/mock';

// S9b: the admins page on the mock API (plan §7.2): add (with the allowlist warning), deactivate,
// ending the own current session, screenshots at 1440/768 in both themes, axe.
const REASON = 'Adminlar boshqaruvi: S9b tekshiruvi';

async function open(page: Page) {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  await page.goto('/admins');
  await expect(page.getByRole('heading', { level: 1, name: 'Adminlar' })).toBeVisible();
}

async function confirm(page: Page, dialog: Locator) {
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: /Kodni olish|Yangi kod olish/ }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
}

async function serious(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target).join(' | ')}`);
}

const table = (page: Page) => page.getByRole('table', { name: 'Adminlar' });

test('add an admin whose Telegram id is not allowlisted yet: the owner is told what to do', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Admin qo‘shish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Admin qo‘shish' });
  await expect(dialog.getByText(/faqat raqamlardan/)).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Telegram ID' }).fill('5550000002');
  await dialog.getByRole('textbox', { name: 'Ism' }).fill('Ali V.');
  await dialog.getByRole('combobox', { name: 'Rol' }).selectOption('OPERATOR');
  await confirm(page, dialog);
  await dialog.getByRole('button', { name: 'Qo‘shish' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert').filter({ hasText: 'hali kira olmaydi' })).toContainText(
    'ADMIN_TELEGRAM_IDS',
  );
  const row = table(page).getByRole('row').filter({ hasText: 'Ali V.' });
  await expect(row.getByText('Ro‘yxatda yo‘q')).toBeVisible();
});

test('a taken Telegram id is named in the dialog', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Admin qo‘shish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Admin qo‘shish' });
  await dialog.getByRole('textbox', { name: 'Telegram ID' }).fill('5409900002');
  await dialog.getByRole('textbox', { name: 'Ism' }).fill('Dilshod 2');
  await confirm(page, dialog);
  await dialog.getByRole('button', { name: 'Qo‘shish' }).click();
  await expect(dialog.getByText('Bu Telegram ID bilan admin allaqachon bor')).toBeVisible();
});

test('deactivate an operator: the row turns inactive and offers reactivation', async ({ page }) => {
  await open(page);
  await expect(table(page).getByText('Faqat CLI')).toBeVisible();
  await page.getByRole('button', { name: 'Deaktivatsiya: Dilshod K.' }).click();
  const dialog = page.getByRole('dialog', { name: 'Adminni deaktivatsiya qilish' });
  await confirm(page, dialog);
  await dialog.getByRole('button', { name: 'Deaktivatsiya' }).dblclick();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Faollashtirish: Dilshod K.' })).toBeVisible();
  const raw = await page.evaluate(() => window.sessionStorage.getItem('ggpin-admin-mock-writes'));
  const journal = JSON.parse(raw ?? '{}') as { audit: { action: string; targetId: string }[] };
  expect(journal.audit.filter((row) => row.targetId === 'mkadm000002')).toHaveLength(1);
});

test('ending the own current session leads to the login page', async ({ page }) => {
  await open(page);
  const sessions = page.getByRole('table', { name: 'Faol sessiyalar' });
  await sessions.getByRole('button', { name: 'Yakunlash: Aziz O. · Chrome · Windows' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sessiyani yakunlash' });
  await expect(dialog.getByText(/joriy sessiyangiz/)).toBeVisible();
  await confirm(page, dialog);
  await dialog.getByRole('button', { name: 'Yakunlash' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Sessiya tugadi. Davom etish uchun qayta kiring.')).toBeVisible();
});

for (const theme of ['light', 'dark'] as ThemeName[]) {
  test(`admins shots and axe, ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await chooseTheme(page, theme);
    await open(page);
    await expect(table(page).getByText('Dilshod K.')).toBeVisible();
    // The sessions arrive after the list: shoot once they are in, not the skeleton.
    await expect(
      page.getByRole('table', { name: 'Faol sessiyalar' }).getByText('Shu sessiya'),
    ).toBeVisible();
    const size = testInfo.project.name;
    await page.screenshot({ path: shotPath(`s9b-admins-${size}-${theme}`), fullPage: true });
    expect(await serious(page)).toEqual([]);

    await page.getByRole('button', { name: 'Admin qo‘shish' }).click();
    const add = page.getByRole('dialog', { name: 'Admin qo‘shish' });
    await add.getByRole('textbox', { name: 'Telegram ID' }).fill('5550000001');
    await add.getByRole('textbox', { name: 'Ism' }).fill('Sardor M.');
    await page.screenshot({ path: shotPath(`s9b-add-${size}-${theme}`) });
    expect(await serious(page)).toEqual([]);
    await add.getByRole('button', { name: 'Bekor' }).click();

    await page.getByRole('button', { name: 'O‘zgartirish: Malika R.' }).click();
    const change = page.getByRole('dialog', { name: 'Adminni o‘zgartirish' });
    await change.getByRole('combobox', { name: 'Rol' }).selectOption('OPERATOR');
    await page.screenshot({ path: shotPath(`s9b-change-${size}-${theme}`) });
    expect(await serious(page)).toEqual([]);
    await change.getByRole('button', { name: 'Bekor' }).click();

    await page.getByRole('button', { name: 'Sessiyalarni yopish: Aziz O.' }).click();
    const revoke = page.getByRole('dialog', { name: 'Sessiyalarni yopish' });
    await expect(revoke.getByText(/egalarga ogohlantirish/)).toBeVisible();
    await page.screenshot({ path: shotPath(`s9b-revoke-owner-${size}-${theme}`) });
    expect(await serious(page)).toEqual([]);
  });
}
