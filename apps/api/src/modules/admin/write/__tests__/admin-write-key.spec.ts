import { ResourceIdSchema } from '@repo/shared';
import { AppError } from '../../../../common/exceptions/app-error';
import { adminAuditIdFor, adminRequestHash } from '../admin-write-key';
import { adminWriteError } from '../admin-write-error';
import { validationError } from '../../../../common/admin/admin-input';

describe('adminAuditIdFor', () => {
  it('one id per (admin, key); a valid resource id', () => {
    const id = adminAuditIdFor('adm1', 'key-12345678');
    expect(ResourceIdSchema.safeParse(id).success).toBe(true);
    expect(id).toHaveLength(32);
    expect(adminAuditIdFor('adm1', 'key-12345678')).toBe(id);
    expect(adminAuditIdFor('adm2', 'key-12345678')).not.toBe(id);
    expect(adminAuditIdFor('adm1', 'key-87654321')).not.toBe(id);
  });
});

describe('adminRequestHash (S3 micro reviews)', () => {
  const body = { amountTiyin: '500', reason: 'manual fix', confirmAmountTiyin: '500' };

  it('ignores the code: same body with another otp (or none) is the same request', () => {
    const plain = adminRequestHash('users.adjustWallet', 'u1', body);
    const otpA = { challengeId: 'a'.repeat(32), code: '111111' };
    const otpB = { challengeId: 'b'.repeat(32), code: '222222' };
    expect(adminRequestHash('users.adjustWallet', 'u1', { ...body, otp: otpA })).toBe(plain);
    expect(adminRequestHash('users.adjustWallet', 'u1', { ...body, otp: otpB })).toBe(plain);
  });

  it('every other field, the target and the route change it; key order does not', () => {
    const plain = adminRequestHash('users.adjustWallet', 'u1', body);
    expect(adminRequestHash('users.adjustWallet', 'u1', { ...body, amountTiyin: '501' })).not.toBe(
      plain,
    );
    expect(
      adminRequestHash('users.adjustWallet', 'u1', { ...body, confirmAmountTiyin: '1' }),
    ).not.toBe(plain);
    expect(adminRequestHash('users.adjustWallet', 'u2', body)).not.toBe(plain);
    expect(adminRequestHash('payments.reverse', 'u1', body)).not.toBe(plain);
    const reordered = { reason: body.reason, confirmAmountTiyin: '500', amountTiyin: '500' };
    expect(adminRequestHash('users.adjustWallet', 'u1', reordered)).toBe(plain);
  });
});

describe('adminWriteError (D-65 D5)', () => {
  const fieldsOf = (error: unknown) => (error as AppError).details?.['fields'];

  it('service reasons become fields; OTP reasons go through the one vocabulary', () => {
    expect(fieldsOf(adminWriteError(validationError('user', 'RECENT_AUTO_TOPUP')))).toEqual([
      { path: 'user', code: 'RECENT_AUTO_TOPUP' },
    ]);
    expect(fieldsOf(adminWriteError(validationError('otp', 'OTP_REQUIRED')))).toEqual([
      { path: 'otp', code: 'OTP_REQUIRED' },
    ]);
    expect(fieldsOf(adminWriteError(validationError('confirmAmountTiyin')))).toEqual([
      { path: 'confirmAmountTiyin', code: 'AMOUNT_MISMATCH' },
    ]);
    expect(fieldsOf(adminWriteError(validationError('reason')))).toEqual([
      { path: 'reason', code: 'INVALID' },
    ]);
  });

  it('a code refused after use is 422 CODE_INVALID (no raw OTP_MISMATCH), nothing left', () => {
    const mapped = adminWriteError(validationError('otp', 'OTP_MISMATCH')) as AppError;
    expect(mapped.code).toBe('CODE_INVALID');
    expect(mapped.details).toEqual({ attemptsLeft: 0 });
    expect((adminWriteError(validationError('otp', 'OTP_EXPIRED')) as AppError).code).toBe(
      'CODE_EXPIRED',
    );
  });

  it('anything else passes unchanged', () => {
    const notFound = new AppError('NOT_FOUND');
    expect(adminWriteError(notFound)).toBe(notFound);
    const plain = new Error('db down');
    expect(adminWriteError(plain)).toBe(plain);
  });
});
