import { expect, test, type Locator, type Page } from '@playwright/test';
import { MOCK_CODE, seedMock } from './support/mock';

const REASON = 'Bank xabari qo‘lda tekshirildi';

async function code(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: /Kodni olish|Yangi kod olish/ }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
}

test.beforeEach(async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
});

test('reverse below the threshold: a reason only', async ({ page }) => {
  await page.goto('/payments?tab=payments');
  const row = page.getByRole('row').filter({ hasText: '30 000' });
  await row.getByRole('button', { name: 'Qaytarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'To‘lovni qaytarish' });
  await expect(dialog.getByRole('button', { name: 'Kodni olish' })).toHaveCount(0);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Qaytarish' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Qaytarish' })).toHaveCount(0);
});

test('reverse above the threshold: re-typed amount + code; spent money freezes purchases', async ({
  page,
}) => {
  await page.goto('/payments?tab=payments');
  const row = page.getByRole('row').filter({ hasText: '600 000' });
  await row.getByRole('button', { name: 'Qaytarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'To‘lovni qaytarish' });
  await dialog.getByRole('textbox', { name: 'Summani qayta kiriting' }).fill('600 000');
  await code(page, dialog);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Qaytarish' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('Pul sarflangan: balans manfiy bo‘ldi va xarid muzlatildi.'),
  ).toBeVisible();
});

test('review credit to the request: preview, bank-verified, code; no "ignore" button', async ({
  page,
}) => {
  await page.goto('/payments?review=mkrev000002');
  const drawer = page.getByRole('dialog', { name: 'To‘lov tekshiruvi' });
  await expect(drawer.getByRole('button', { name: 'Eʼtiborsiz qoldirish' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Hisobga o‘tkazish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hisobga o‘tkazish' });
  await expect(dialog.getByRole('textbox', { name: 'So‘rov ID' })).toHaveValue('mkint000005');
  await expect(dialog.getByText('Hisoblashdan oldin')).toBeVisible();
  const submit = dialog.getByRole('button', { name: 'Hisobga o‘tkazish' });
  await dialog.getByRole('textbox', { name: 'Summani qayta kiriting' }).fill('75 000');
  await expect(dialog.getByRole('button', { name: 'Kodni olish' })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: /bankda kelganini o‘zim tekshirdim/ }).check();
  await code(page, dialog);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
});

test('a review that is not a parsed credit is CLI-only', async ({ page }) => {
  await page.goto('/payments?review=mkrev000003');
  const drawer = page.getByRole('dialog', { name: 'To‘lov tekshiruvi' });
  await expect(drawer.getByText('Bu turdagi tekshiruv faqat CLI orqali yopiladi.')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Hisobga o‘tkazish' })).toHaveCount(0);
});

test('card limit: lowering asks for the code', async ({ page }) => {
  await page.goto('/payments?tab=cards');
  const humo = page.getByRole('group', { name: 'HUMO •4417 kartasi amallari' });
  await humo.getByRole('button', { name: 'Limit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Karta limiti' });
  await expect(dialog.getByRole('textbox', { name: 'Qabul limiti' })).toHaveValue('500000000');
  await dialog.getByRole('textbox', { name: 'Qabul limiti' }).fill('400 000 000');
  await expect(dialog.getByText('Limit pasaymoqda: kod bilan tasdiqlanadi.')).toBeVisible();
  await code(page, dialog);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Bank limitni kamaytirdi');
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(dialog).toBeHidden();
  await expect(humo.locator('..').getByText('400 000 000 so‘m')).toBeVisible();
});

test('resume a SECURITY pause: the API names what is needed, then the code', async ({ page }) => {
  await page.goto('/payments?tab=cards');
  const uzcard = page.getByRole('group', { name: 'UZCARD •0921 kartasi amallari' });
  await uzcard.getByRole('button', { name: 'Davom ettirish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kartani davom ettirish' });
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Xavfsizlik tekshiruvi tugadi');
  const submit = dialog.getByRole('button', { name: 'Davom ettirish' });
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('xavfsizlik sababli to‘xtatilgan');
  await dialog.getByRole('checkbox', { name: /Xavfsizlik pauzasini/ }).check();
  await code(page, dialog);
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('ochiq tekshiruvlar bor');
  await dialog.getByRole('checkbox', { name: /baribir davom ettirish/ }).check();
  await code(page, dialog);
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(uzcard.getByRole('button', { name: 'Pauza' })).toBeVisible();
});

test('retire always asks for the code', async ({ page }) => {
  await page.goto('/payments?tab=cards');
  const humo = page.getByRole('group', { name: 'HUMO •4417 kartasi amallari' });
  await humo.getByRole('button', { name: 'Chiqarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kartani foydalanishdan chiqarish' });
  await expect(dialog.getByRole('button', { name: 'Kodni olish' })).toBeVisible();
  await code(page, dialog);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Karta yopildi, yangisi ochiladi');
  await dialog.getByRole('button', { name: 'Chiqarish' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Yopilmoqda').first()).toBeVisible();
});
