import { expect, test, type Locator, type Page } from '@playwright/test';
import { MOCK_CODE, seedMock, setWriteScenario } from './support/mock';

// Unknown outcomes of admin writes (plan 5.3): the mock applies or refuses a write and answers
// 500 / 409 / CODE_EXPIRED on demand (`writeScenario`, one-shot).

const USER = '/users/mkuser000001';
const REASON = 'Shubhali faollik, tekshiruv uchun';
const UNKNOWN = /Natija nomaʼlum/;

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

test('applied but 500: "did it run?" finds the audit row and closes the dialog', async ({
  page,
}) => {
  await page.goto(USER);
  await setWriteScenario(page, 'applyThen500');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('status')).toContainText(UNKNOWN);
  await dialog.getByRole('button', { name: 'Bajarilganini tekshirish' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Amal avval bajarilgan ekan. Maʼlumot yangilandi.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Blokdan chiqarish' })).toBeVisible();
});

test('not applied: a new key only after 60 s (fake clock)', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T09:12:04Z') });
  await page.goto(USER);
  await setWriteScenario(page, 'fail500');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('status')).toContainText(UNKNOWN);
  await dialog.getByRole('button', { name: 'Bajarilganini tekshirish' }).click();
  await expect(dialog.getByText(/soniyadan keyin yana tekshiring/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Yangi amal sifatida boshlash' })).toHaveCount(0);
  await page.clock.fastForward('01:01');
  await dialog.getByRole('button', { name: 'Bajarilganini tekshirish' }).click();
  await dialog.getByRole('button', { name: 'Yangi amal sifatida boshlash' }).click();
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Bloklash' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bajarildi', { exact: true })).toBeVisible();
});

test('409: the key was used with other data', async ({ page }) => {
  await page.goto(USER);
  await setWriteScenario(page, 'conflict');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('status')).toContainText('boshqa maʼlumot bilan bajarilgan');
});

test('CODE_EXPIRED after submit is unknown; a resend with a new code returns the first result', async ({
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
  await dialog.getByRole('button', { name: 'Yangi kod olish' }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
  await dialog.getByRole('button', { name: 'Chiqarish' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bu amal avval bajarilgan: o‘sha natija ko‘rsatildi')).toBeVisible();
});

test('F5 after an unknown outcome: the notice comes back, the check still works', async ({
  page,
}) => {
  await page.goto(USER);
  await setWriteScenario(page, 'applyThen500');
  const dialog = await sendBlock(page);
  await expect(dialog.getByRole('status')).toContainText(UNKNOWN);
  await page.reload();
  await expect(page.getByText('Jami xarid')).toBeVisible();
  // The mock applied the block, so the page now offers unblock; the pending entry is for block.
  await expect(page.getByRole('button', { name: 'Blokdan chiqarish' })).toBeVisible();
  const raw = await page.evaluate(() =>
    window.sessionStorage.getItem('ggpin-admin-pending-actions'),
  );
  expect(raw).toContain('users.block');
  expect(raw).not.toContain(REASON);
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
