import { expect, type Locator, type Page } from '@playwright/test';
import { setWriteScenario } from './mock';

// The opposite-action states of 9B-3 (SA L-2, L-4, N-3) on the mock API, shared by the opposite
// spec and the screenshot spec.

export const USER = '/users/mkuser000001';
export const REASON = 'Shubhali faollik, tekshiruv uchun';
export const RESOLVE = 'Natijani aniqlash';
export const JOURNAL = 'ggpin-admin-mock-writes';

/** An unknown block that did run, then the unblock dialog after a reload: locked (SA L-2). */
export async function oppositeLocked(page: Page): Promise<Locator> {
  await page.goto(USER);
  await setWriteScenario(page, 'applyThen500');
  await page.getByRole('button', { name: 'Bloklash' }).click();
  const block = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
  await block.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await block.getByRole('button', { name: 'Bloklash' }).click();
  await expect(block.getByRole('button', { name: RESOLVE })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Blokdan chiqarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Blokdan chiqarish' });
  await expect(dialog.getByText(/«Foydalanuvchini bloklash» amalining natijasi/)).toBeVisible();
  return dialog;
}

/**
 * N-3: an unknown block that never ran, while another admin blocked the user meanwhile (the mock
 * journal is changed as that admin would): the unblock dialog voids the block, VOIDED.
 */
export async function oppositeVoided(page: Page): Promise<Locator> {
  await page.goto(USER);
  await setWriteScenario(page, 'fail500');
  await page.getByRole('button', { name: 'Bloklash' }).click();
  const block = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
  await block.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await block.getByRole('button', { name: 'Bloklash' }).click();
  await expect(block.getByRole('button', { name: RESOLVE })).toBeVisible();
  await page.evaluate((key) => {
    const journal = JSON.parse(window.sessionStorage.getItem(key) ?? '{}') as {
      users?: Record<string, { isBlocked?: boolean }>;
    };
    journal.users = { ...journal.users, mkuser000001: { isBlocked: true } };
    window.sessionStorage.setItem(key, JSON.stringify(journal));
  }, JOURNAL);
  await page.reload();
  await page.getByRole('button', { name: 'Blokdan chiqarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Blokdan chiqarish' });
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(
    dialog.getByText('Avvalgi «Foydalanuvchini bloklash» amali bajarilmagan.', { exact: false }),
  ).toBeVisible();
  return dialog;
}

/**
 * SA L-4: a block that ran but whose answer never came is still out; the dialog left with an
 * in-app navigation, a note refreshed the user, and the unblock dialog waits without a void.
 */
export async function oppositeInFlight(page: Page): Promise<Locator> {
  await page.goto('/users');
  await page.getByText('@sardor_r').click();
  await expect(page).toHaveURL(/\/users\/mkuser000001/);
  await expect(page.getByText('Jami xarid')).toBeVisible();
  await setWriteScenario(page, 'applyThenHang');
  await page.getByRole('button', { name: 'Bloklash' }).click();
  const block = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
  await block.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await block.getByRole('button', { name: 'Bloklash' }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/users$/);
  await page.goForward();
  await expect(page.getByText('Jami xarid')).toBeVisible();
  await page.getByRole('button', { name: 'Izoh qo‘shish' }).click();
  const note = page.getByRole('dialog', { name: 'Izoh qo‘shish' });
  await note.getByRole('textbox', { name: /Izoh matni/ }).fill('Blok so‘rovi kutilmoqda');
  await note.getByRole('button', { name: 'Saqlash' }).click();
  await expect(note).toBeHidden();
  await page.getByRole('button', { name: 'Blokdan chiqarish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Blokdan chiqarish' });
  await expect(dialog.getByText(/«Foydalanuvchini bloklash» so‘rovi hali yo‘lda/)).toBeVisible();
  return dialog;
}
