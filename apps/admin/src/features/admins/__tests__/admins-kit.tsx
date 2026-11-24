// Shared helpers of the S9b dialog tests (not a test file itself).
import type { AdminAccount, AdminPermission } from '@repo/shared';
import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { expect } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { ADMINS } from '../../../lib/api/mock/fixtures-ops';
import { renderAdmin } from '../../../test/render';

export const REASON = 'Yangi navbatchi operator kerak';
export const NOW = new Date('2026-11-24T09:00:00Z');

export function adminAt(index: number): AdminAccount {
  const admin = ADMINS[index];
  if (admin === undefined) throw new Error('fixture');
  return admin;
}

export function asOwner(ui: ReactNode, without: readonly AdminPermission[] = []) {
  const me = meFixture('OWNER', NOW);
  const value = { ...me, permissions: me.permissions.filter((p) => !without.includes(p)) };
  return renderAdmin(
    <MemoryRouter>
      <AdminContext.Provider value={value}>{ui}</AdminContext.Provider>
    </MemoryRouter>,
  );
}

export async function typeCode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Kodni olish' }));
  expect(await screen.findByText(/amal qiladi/)).toBeInTheDocument();
  await user.keyboard('123456');
}

export function result(admin: AdminAccount, applied = true) {
  return { admin, auditId: 'a0000000000000000000000000000001', applied };
}

/** The dialog's submit button: "Yopish" is both the end-sessions CTA and the close icon's name. */
export function submitButton(name: string): HTMLElement {
  const found = screen
    .getAllByRole('button', { name })
    .find((button) => button.getAttribute('type') === 'submit');
  if (found === undefined) throw new Error(`no submit button "${name}"`);
  return found;
}
