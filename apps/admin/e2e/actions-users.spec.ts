import { expect, test, type Page } from '@playwright/test';
import { MOCK_CODE, seedMock } from './support/mock';

const USER = '/users/mkuser000001';
const REASON = 'Shubhali faollik, tekshiruv uchun';

async function openUser(page: Page, role: 'OWNER' | 'OPERATOR' | 'SUPPORT' = 'OWNER') {
  await seedMock(page, { signedIn: true, role });
  await page.goto(USER);
  await expect(page.getByText('Jami xarid')).toBeVisible();
}

async function typeCode(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Kodni olish' }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
}

test('block: reason, done toast with the ended sessions, then unblock is offered', async ({
  page,
}) => {
  await openUser(page);
  await page.getByRole('button', { name: 'Bloklash' }).click();
  const dialog = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
  await expect(dialog).toContainText('@sardor_r ilovaga kira olmaydi');
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Bloklash' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
  await expect(page.getByText('2 ta sessiya tugatildi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Blokdan chiqarish' })).toBeVisible();
  await expect(page.getByText('Bloklangan', { exact: true }).first()).toBeVisible();
});

test('wallet adjustment: preview, both confirmations, re-typed amount and the code', async ({
  page,
}) => {
  await openUser(page);
  await page.getByRole('button', { name: 'Balansni tuzatish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Balansni tuzatish' });
  await dialog.getByRole('textbox', { name: 'Summa', exact: true }).fill('150 000');
  await expect(dialog.getByText('So‘nggi 7 kundagi avtomatik to‘ldirishlar')).toBeVisible();
  await expect(dialog).toContainText('235 400');
  const submit = dialog.getByRole('button', { name: 'Tuzatish' });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /to‘ldirishlarni ko‘rdim/ }).check();
  await dialog.getByRole('checkbox', { name: /buyurtmalarni ko‘rdim/ }).check();
  await dialog.getByRole('textbox', { name: 'Summani qayta kiriting' }).fill('150000');
  await typeCode(page);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Kompensatsiya: buyurtma kechikdi');
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
  await expect(page.getByText('235 400 so‘m').first()).toBeVisible();
});

test('a wrong re-typed amount keeps the code step closed', async ({ page }) => {
  await openUser(page);
  await page.getByRole('button', { name: 'Balansni tuzatish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Balansni tuzatish' });
  await dialog.getByRole('radio', { name: 'Ayirish' }).click();
  await dialog.getByRole('textbox', { name: 'Summa', exact: true }).fill('200 000');
  const retype = dialog.getByRole('textbox', { name: 'Summani qayta kiriting' });
  await retype.fill('20 000');
  await retype.blur();
  await expect(dialog.getByText('Summa birinchisiga mos emas')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Kodni olish' })).toHaveCount(0);
});

test('SUPPORT adds a note; it shows in the notes panel', async ({ page }) => {
  await openUser(page, 'SUPPORT');
  await expect(page.getByRole('button', { name: 'Bloklash' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Izoh qo‘shish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Izoh qo‘shish' });
  await dialog
    .getByRole('textbox', { name: /Izoh matni/ })
    .fill('Qo‘ng‘iroq qilindi, to‘lovni kutyapti');
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Qo‘ng‘iroq qilindi, to‘lovni kutyapti')).toBeVisible();
  await expect(page.getByText('1 ta izoh')).toBeVisible();
});

test('OPERATOR freezes; lifting it is for OWNER only', async ({ page }) => {
  await openUser(page, 'OPERATOR');
  await page.getByRole('button', { name: 'Xaridni muzlatish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Xaridni muzlatish' });
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Muzlatish' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Xaridni muzlatish' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Muzlatishni ochish' })).toHaveCount(0);
});
