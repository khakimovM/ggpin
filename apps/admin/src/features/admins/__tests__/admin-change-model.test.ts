import {
  AdminConfirmationBodySchema,
  AdminCreateBodySchema,
  AdminUpdateBodySchema,
  type AdminAccount,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  adminChangeOf,
  createBody,
  createConfirmation,
  newAdminOf,
  updateBody,
  updateConfirmation,
} from '../admin-change-model';

const ROW: Pick<AdminAccount, 'name' | 'role' | 'isActive'> = {
  name: 'Dilshod K.',
  role: 'OPERATOR',
  isActive: true,
};
const OTP = { challengeId: '0123456789abcdef0123456789abcdef', code: '123456' };
const REASON = 'Vazifalari o‘zgardi, rolni almashtirish';

describe('admin-change-model: one builder, only what changes', () => {
  it('a role change sends the role alone; the name typed the same is left out', () => {
    const change = adminChangeOf(ROW, { name: ' Dilshod K. ', role: 'SUPPORT' });
    expect(change).toEqual({ role: 'SUPPORT' });
  });

  it('a rename sends the trimmed name alone', () => {
    expect(adminChangeOf(ROW, { name: '  Dilshod Karimov ', role: 'OPERATOR' })).toEqual({
      name: 'Dilshod Karimov',
    });
  });

  it('nothing changed is null: no empty PATCH and no code for it', () => {
    expect(adminChangeOf(ROW, { name: 'Dilshod K.', role: 'OPERATOR' })).toBeNull();
    expect(adminChangeOf(ROW, { isActive: true })).toBeNull();
  });

  it('deactivate and reactivate send isActive alone', () => {
    expect(adminChangeOf(ROW, { isActive: false })).toEqual({ isActive: false });
    expect(adminChangeOf({ ...ROW, isActive: false }, { isActive: true })).toEqual({
      isActive: true,
    });
  });

  it('the confirmation and the body carry the same fields (the code is bound to them)', () => {
    const change = adminChangeOf(ROW, { name: 'Dilshod', role: 'SUPPORT' });
    if (change === null) throw new Error('expected a change');
    const confirmation = AdminConfirmationBodySchema.parse(
      updateConfirmation('mkadm000002', change),
    );
    const body = AdminUpdateBodySchema.parse(updateBody(change, REASON, OTP));
    expect(confirmation).toEqual({
      action: 'admins.update',
      targetId: 'mkadm000002',
      name: 'Dilshod',
      role: 'SUPPORT',
    });
    const { reason: _reason, otp: _otp, ...sent } = body;
    expect({ action: 'admins.update', targetId: 'mkadm000002', ...sent }).toEqual(confirmation);
  });

  it('a new admin: trimmed, valid fields only, and the same three fields bound', () => {
    expect(newAdminOf({ telegramId: '0123', name: 'Ali', role: 'SUPPORT' })).toBeNull();
    expect(newAdminOf({ telegramId: '12a', name: 'Ali', role: 'SUPPORT' })).toBeNull();
    expect(newAdminOf({ telegramId: '123', name: '  ', role: 'SUPPORT' })).toBeNull();
    expect(newAdminOf({ telegramId: '123', name: '<b>', role: 'SUPPORT' })).toBeNull();
    const admin = newAdminOf({ telegramId: ' 5550000002 ', name: ' Ali V. ', role: 'OPERATOR' });
    expect(admin).toEqual({ telegramId: '5550000002', name: 'Ali V.', role: 'OPERATOR' });
    if (admin === null) throw new Error('expected an admin');
    expect(AdminConfirmationBodySchema.parse(createConfirmation(admin))).toEqual({
      action: 'admins.create',
      ...admin,
    });
    expect(AdminCreateBodySchema.parse(createBody(admin, REASON, OTP))).toEqual({
      ...admin,
      reason: REASON,
      otp: OTP,
    });
  });
});
