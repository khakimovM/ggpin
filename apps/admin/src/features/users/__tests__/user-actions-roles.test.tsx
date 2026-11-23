import type { AdminRole, AdminUserDetailResponse } from '@repo/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { USERS } from '../../../lib/api/mock/fixtures-users';
import { renderAdmin } from '../../../test/render';
import { UserActions } from '../UserActions';
import { UserNotes } from '../UserNotes';

function user(patch: Partial<AdminUserDetailResponse> = {}): AdminUserDetailResponse {
  const row = USERS[0];
  if (row === undefined) throw new Error('fixture');
  return {
    ...row,
    lastName: null,
    photoUrl: null,
    phone: null,
    referralCode: 'X',
    referredBy: null,
    activeSessionsCount: 2,
    notes: [],
    ...patch,
  };
}

function renderAs(role: AdminRole, target = user()) {
  renderAdmin(
    <AdminContext.Provider value={meFixture(role, new Date())}>
      <UserActions user={target} name="@sardor_r" />
      <UserNotes userId={target.id} name="@sardor_r" notes={target.notes} />
    </AdminContext.Provider>,
  );
}

const names = () => screen.getAllByRole('button').map((button) => button.textContent);

describe('user action buttons by role (UX only; the API decides)', () => {
  it('OWNER: block, freeze, adjust, sessions, note', () => {
    renderAs('OWNER');
    expect(names()).toEqual([
      'Bloklash',
      'Xaridni muzlatish',
      'Balansni tuzatish',
      'Sessiyalarni tugatish',
      'Izoh qo‘shish',
    ]);
  });

  it('OPERATOR: no wallet adjustment', () => {
    renderAs('OPERATOR');
    expect(names()).toEqual([
      'Bloklash',
      'Xaridni muzlatish',
      'Sessiyalarni tugatish',
      'Izoh qo‘shish',
    ]);
  });

  it('SUPPORT: only a note', () => {
    renderAs('SUPPORT');
    expect(names()).toEqual(['Izoh qo‘shish']);
  });

  it('a blocked, frozen user: OWNER sees unblock and unfreeze', () => {
    renderAs('OWNER', user({ isBlocked: true, purchaseFrozen: true }));
    expect(names()).toContain('Blokdan chiqarish');
    expect(names()).toContain('Muzlatishni ochish');
    expect(names()).not.toContain('Bloklash');
  });

  it('a blocked, frozen user: OPERATOR may not lift either (OWNER only, D-65 D2)', () => {
    renderAs('OPERATOR', user({ isBlocked: true, purchaseFrozen: true }));
    expect(names()).not.toContain('Blokdan chiqarish');
    expect(names()).not.toContain('Muzlatishni ochish');
  });
});
