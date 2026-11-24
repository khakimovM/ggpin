import { expect, test, type Locator, type Page } from '@playwright/test';
import { MOCK_CODE, seedMock, setVoidScenario, setWriteScenario } from './support/mock';

// Unknown outcomes of admin writes, settled by the key void (docs/04, 9-B Q2 = A): the mock
// applies or refuses a write and answers 500 / 409 / CODE_EXPIRED / 503 on demand
// (`writeScenario`, one-shot), and the void answers APPLIED / VOIDED, or 503 / 404 on demand.

const USER = '/users/mkuser000001';
const REASON = 'Shubhali faollik, tekshiruv uchun';
const UNKNOWN = /Natija nomaʼlum/;
const RESOLVE = 'Natijani aniqlash';

async function openBlock(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Bloklash' }).click();
  return page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
}

async function sendBlock(page: Page): Promise<Locator> {
  const dialog = await openBlock(page);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Bloklash' }).click();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
});

test('applied but 500: the void says APPLIED, the dialog closes with the audit row', async ({
  page,
}) => {
  await page.goto(USER);
  await setWriteScenario(page, 'applyThen500');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('status')).toContainText(UNKNOWN);
  await expect(dialog.getByRole('button', { name: 'Bloklash' })).toBeDisabled();
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Amal avval bajarilgan ekan. Maʼlumot yangilandi.')).toBeVisible();
  await expect(page.getByText(/Audit yozuvi: .+ · a[0-9a-f]{31}/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Blokdan chiqarish' })).toBeVisible();
});

test('not applied: the void says VOIDED, a new key at once, no wait', async ({ page }) => {
  await page.goto(USER);
  await setWriteScenario(page, 'fail500');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('status')).toContainText(UNKNOWN);
  const send = dialog.getByRole('button', { name: 'Bloklash' });
  await expect(send).toBeDisabled();
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(dialog.getByText(/Avvalgi so‘rov bajarilmagan/)).toBeVisible();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
  const journal = await page.evaluate(() =>
    window.sessionStorage.getItem('ggpin-admin-mock-writes'),
  );
  expect(journal?.match(/"IDEMPOTENCY_VOID"/g)).toHaveLength(1);
  expect(journal?.match(/"USER_BLOCK"/g)).toHaveLength(1);
});

test('the void itself fails (503 deadline, then 404): the key stays, asked again', async ({
  page,
}) => {
  await page.goto(USER);
  await setWriteScenario(page, 'fail500');
  const dialog = await sendBlock(page);
  await setVoidScenario(page, 'deadline503');
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(dialog.getByText(/Natijani aniqlab bo‘lmadi/)).toBeVisible();
  await expect(dialog.getByText(/Avvalgi so‘rov bajarilmagan/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Bloklash' })).toBeDisabled();
  await setVoidScenario(page, 'notFound');
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(dialog.getByText(/Natijani aniqlab bo‘lmadi/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Bloklash' })).toBeDisabled();
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(dialog.getByText(/Avvalgi so‘rov bajarilmagan/)).toBeVisible();
});

test('409: the key was used with other data — the existing text and the void', async ({ page }) => {
  await page.goto(USER);
  await setWriteScenario(page, 'conflict');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('alert')).toContainText(
    'kalit avval ishlatilgan yoki bekor qilingan',
  );
  await expect(dialog.getByRole('alert')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: RESOLVE })).toBeFocused();
  await expect(dialog.getByRole('button', { name: RESOLVE })).toBeEnabled();
});

test('write deadline 503: nothing written, the key stays, a resend is a real write', async ({
  page,
}) => {
  await page.goto(USER);
  await setWriteScenario(page, 'deadline503');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('alert')).toContainText('hech narsa yozilmadi');
  await expect(dialog.getByRole('button', { name: RESOLVE })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Bloklash' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
});

test('write deadline 503 on a coded action: same key, a new code is asked', async ({ page }) => {
  await page.goto('/payments?tab=cards');
  const humo = page.getByRole('group', { name: 'HUMO •4417 kartasi amallari' });
  await humo.getByRole('button', { name: 'Chiqarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kartani foydalanishdan chiqarish' });
  await dialog.getByRole('button', { name: 'Kodni olish' }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Karta yopildi, yangisi ochiladi');
  await setWriteScenario(page, 'deadline503');
  const send = dialog.getByRole('button', { name: 'Chiqarish' });
  await send.click();
  await expect(dialog.getByText(/Yangi kod oling va qayta yuboring/)).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Kod, 1-raqam' })).toHaveCount(0);
  await expect(send).toBeDisabled();
  await dialog.getByRole('button', { name: 'Yangi kod olish' }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
  await send.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
});

test('CODE_EXPIRED after submit is unknown: locked, the void finds it applied', async ({
  page,
}) => {
  await page.goto('/payments?tab=cards');
  const humo = page.getByRole('group', { name: 'HUMO •4417 kartasi amallari' });
  await humo.getByRole('button', { name: 'Chiqarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kartani foydalanishdan chiqarish' });
  await dialog.getByRole('button', { name: 'Kodni olish' }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Karta yopildi, yangisi ochiladi');
  await setWriteScenario(page, 'applyThenCodeExpired');
  await dialog.getByRole('button', { name: 'Chiqarish' }).click();
  await expect(dialog.getByRole('status')).toContainText(UNKNOWN);
  await expect(dialog.getByRole('button', { name: 'Chiqarish' })).toBeDisabled();
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Amal avval bajarilgan ekan. Maʼlumot yangilandi.')).toBeVisible();
});

test('F5 after an unknown outcome: the entry survives the reload without the reason', async ({
  page,
}) => {
  await page.goto(USER);
  await setWriteScenario(page, 'applyThen500');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('status')).toContainText(UNKNOWN);
  await page.reload();
  await expect(page.getByText('Jami xarid')).toBeVisible();
  const raw = await page.evaluate(() =>
    window.sessionStorage.getItem('ggpin-admin-pending-actions'),
  );
  expect(raw).toContain('users.block');
  expect(raw).not.toContain(REASON);
  // The mock applied the block, so the page offers unblock; the pending entry is for block.
  await expect(page.getByRole('button', { name: 'Blokdan chiqarish' })).toBeVisible();
});

test('a double click sends one request', async ({ page }) => {
  await page.goto(USER);
  await page.getByRole('button', { name: 'Izoh qo‘shish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Izoh qo‘shish' });
  await dialog.getByRole('textbox', { name: /Izoh matni/ }).fill('Bir marta yozilishi kerak');
  await dialog.getByRole('button', { name: 'Saqlash' }).dblclick();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bir marta yozilishi kerak')).toHaveCount(1);
  await expect(page.getByText('1 ta izoh')).toBeVisible();
  const audit = await page.evaluate(() => window.sessionStorage.getItem('ggpin-admin-mock-writes'));
  expect(audit?.match(/"USER_NOTE"/g)).toHaveLength(1);
});
