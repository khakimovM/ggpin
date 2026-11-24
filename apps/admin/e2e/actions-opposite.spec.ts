import { expect, test } from '@playwright/test';
import { seedMock } from './support/mock';
import {
  JOURNAL,
  REASON,
  RESOLVE,
  oppositeInFlight,
  oppositeLocked,
  oppositeVoided,
} from './support/opposite';

// An opposite action on the same target that may still commit locks this one (SA L-2, L-4); its
// void is offered here, APPLIED keeps the dialog (N-2), VOIDED has its own text (N-3).

test('an unknown block locks the unblock until its void (SA L-2)', async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  const dialog = await oppositeLocked(page);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await expect(dialog.getByRole('button', { name: 'Blokdan chiqarish' })).toBeDisabled();
  await dialog.getByRole('button', { name: RESOLVE }).click();
  // The block ran (APPLIED, N-2): the dialog stays for the admin to decide, unlocked; the toast
  // names the block's audit row; nothing else was sent.
  await expect(page.getByText('Amal avval bajarilgan ekan. Maʼlumot yangilandi.')).toBeVisible();
  await expect(
    page.getByText(/Audit yozuvi: Foydalanuvchi bloklandi · a[0-9a-f]{31}/),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Blokdan chiqarish' })).toBeEnabled();
  const journal = await page.evaluate((key) => window.sessionStorage.getItem(key), JOURNAL);
  expect(journal?.match(/"USER_UNBLOCK"/g) ?? []).toHaveLength(0);
});

test('a voided opposite says so and unlocks (N-3)', async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  const dialog = await oppositeVoided(page);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await expect(dialog.getByRole('button', { name: 'Blokdan chiqarish' })).toBeEnabled();
});

test('an opposite still out locks without a void (SA L-4)', async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  const dialog = await oppositeInFlight(page);
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await expect(dialog.getByRole('button', { name: RESOLVE })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Blokdan chiqarish' })).toBeDisabled();
  const journal = await page.evaluate((key) => window.sessionStorage.getItem(key), JOURNAL);
  expect(journal?.match(/"USER_UNBLOCK"/g) ?? []).toHaveLength(0);
});
