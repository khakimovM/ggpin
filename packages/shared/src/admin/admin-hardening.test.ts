// Review round tests (phase 9 S1 fix): run-time hardening of the matrix, code issuance, the
// confirmation binding and the OTP error vocabulary (SA-L2, SA-M1, SA-M2, D-65 D5).
import { describe, expect, it } from 'vitest';
import * as a from './index';

const REASON = 'Mijoz pulni qaytarishni so‘radi';
const ctx = (totalTiyin: bigint, attemptCapHold = false) => ({
  totalTiyin,
  operatorLimitTiyin: 50_000_000n,
  attemptCapHold,
  noPurchaseHold: false,
});
const thresholdTiyin = 100_000_000n;
const unknownKey = (key: string) => key as unknown as a.AdminPermission;

describe('matrix at run time', () => {
  it('is frozen to the leaves', () => {
    const rule = a.ADMIN_PERMISSIONS['orders.cancel'];
    for (const node of [a.ADMIN_PERMISSIONS, rule, rule.roles, rule.routes, rule.routes[0]]) {
      expect(Object.isFrozen(node)).toBe(true);
    }
    expect(Object.isFrozen(rule.auditActions)).toBe(true);
    for (const list of [a.ADMIN_PERMISSION_KEYS, a.ADMIN_OTP_PERMISSIONS, a.ADMIN_AUTH_ROUTES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect(Object.isFrozen(a.ADMIN_AUTH_ROUTES[0])).toBe(true);
    expect(Object.isFrozen(a.ADMIN_PERMISSIONS['orders.retry'].ownerOnlyHolds)).toBe(true);
    expect(() => {
      (rule.roles as string[]).push('SUPPORT');
    }).toThrow(TypeError);
    expect(a.roleHas('SUPPORT', 'orders.cancel')).toBe(false);
  });

  it('answers false / "code needed" for a key that is not in the matrix', () => {
    for (const key of ['nope', 'toString', '__proto__', 'constructor']) {
      expect(a.roleHas('OWNER', unknownKey(key)), key).toBe(false);
      expect(a.adminMayPerform('OWNER', unknownKey(key)), key).toBe(false);
      expect(a.adminOtpRequired(unknownKey(key), { thresholdTiyin }), key).toBe(true);
    }
  });
});

describe('adminCodeIssueDecision', () => {
  const small = { amountTiyin: 1n, thresholdTiyin };
  const big = { amountTiyin: thresholdTiyin + 1n, thresholdTiyin };

  it('issues only for an action the admin may perform now, else 404', () => {
    expect(
      a.adminCodeIssueDecision('OPERATOR', 'orders.cancel', { order: ctx(1n), otp: big }),
    ).toBe('ISSUE');
    expect(
      a.adminCodeIssueDecision('OPERATOR', 'orders.cancel', { order: ctx(50_000_001n), otp: big }),
    ).toBe('NOT_FOUND');
    expect(a.adminCodeIssueDecision('OPERATOR', 'orders.cancel', { otp: big })).toBe('NOT_FOUND');
    expect(
      a.adminCodeIssueDecision('OPERATOR', 'orders.cancel', { order: ctx(1n, true), otp: big }),
    ).toBe('ISSUE');
    expect(a.adminCodeIssueDecision('OPERATOR', 'orders.refund', { otp: big })).toBe('NOT_FOUND');
    expect(a.adminCodeIssueDecision('OPERATOR', 'admins.create', { otp: big })).toBe('NOT_FOUND');
    expect(a.adminCodeIssueDecision('SUPPORT', 'orders.cancel', { order: ctx(1n), otp: big })).toBe(
      'NOT_FOUND',
    );
  });

  it('refuses to send a code that the action would not ask for', () => {
    expect(a.adminCodeIssueDecision('OWNER', 'orders.cancel', { otp: small })).toBe('NOT_REQUIRED');
    expect(a.adminCodeIssueDecision('OWNER', 'orders.refund', { otp: small })).toBe('ISSUE');
    expect(a.adminCodeIssueDecision('OWNER', 'admins.update', { otp: { thresholdTiyin } })).toBe(
      'ISSUE',
    );
  });
});

describe('confirmation binding', () => {
  const otp = { challengeId: 'a'.repeat(32), code: '123456' };
  const parse = (body: unknown) => a.AdminConfirmationBodySchema.parse(body);
  const canon = (body: unknown) => a.adminConfirmationCanonical(parse(body));

  it('binds every field, in any key order, with defaults filled', () => {
    const credit = { action: 'payments.reviewCredit', targetId: 'rev_1', amountTiyin: '5' };
    expect(canon({ ...credit, userId: 'u_1' })).toBe(canon({ userId: 'u_1', ...credit }));
    expect(canon({ ...credit, userId: 'u_1' })).toBe(
      canon({ ...credit, userId: 'u_1', confirmOverride: false, bankVerified: false }),
    );
    expect(canon({ ...credit, userId: 'u_1' })).not.toBe(
      canon({ ...credit, userId: 'u_1', bankVerified: true }),
    );
    expect(canon({ action: 'fx.set', pair: 'USDT_UZS', rate: '12650' })).not.toBe(
      canon({ action: 'fx.set', pair: 'USDT_UZS', rate: '99999' }),
    );
    expect(canon({ action: 'admins.update', targetId: 'a_1', name: 'Ali' })).toBe(
      '{"action":"admins.update","name":"Ali","targetId":"a_1"}',
    );
  });

  it('carries the resolve reason, the adjustment key and the admin name', () => {
    const resolve = {
      action: 'orders.resolve',
      targetId: 'o_1',
      amountTiyin: '1',
      outcome: 'FAILED',
      proof: { kind: 'MANUAL', evidence: 'chek' },
    };
    const ok = (body: unknown) => a.AdminConfirmationBodySchema.safeParse(body).success;
    expect(ok(resolve)).toBe(false);
    expect(ok({ ...resolve, reason: REASON })).toBe(true);
    const adjust = { action: 'users.adjustWallet', targetId: 'u_1', amountTiyin: '-5' };
    expect(ok(adjust)).toBe(false);
    expect(ok({ ...adjust, idempotencyKey: 'adj-2026-11-16-01' })).toBe(true);
    expect(ok({ action: 'admins.create', telegramId: '123', role: 'SUPPORT' })).toBe(false);
    expect(ok({ action: 'admins.create', telegramId: '123', role: 'SUPPORT', name: 'Ali' })).toBe(
      true,
    );
    expect(ok({ action: 'admins.update', targetId: 'a_1' })).toBe(false);
    expect(ok({ action: 'cards.resume', targetId: 'c_1', confirmSecurityPause: true })).toBe(true);
    expect(
      a.AdminCardResumeBodySchema.safeParse({ reason: REASON, confirmSecurityPause: true, otp })
        .success,
    ).toBe(true);
  });
});

describe('OTP refusals (D-65 D5)', () => {
  it('never shows a raw service reason that tells why a code failed', () => {
    for (const raw of ['OTP_EXPIRED', 'OTP_MISMATCH', 'OTP_INVALID', 'CONFIRMATION_REQUIRED']) {
      expect(a.ADMIN_FIELD_ERROR_CODES as readonly string[]).not.toContain(raw);
    }
    for (const reason of a.ADMIN_OTP_SERVICE_REASONS) {
      const answer = a.adminOtpHttpError(reason);
      if (answer.status === 400) expect(a.ADMIN_FIELD_ERROR_CODES).toContain(answer.field.code);
      else expect(['CODE_INVALID', 'CODE_EXPIRED']).toContain(answer.code);
    }
  });

  it('maps each reason to one answer', () => {
    expect(a.adminOtpHttpError('OTP_MISMATCH')).toEqual({ status: 422, code: 'CODE_INVALID' });
    expect(a.adminOtpHttpError('OTP_INVALID')).toEqual({ status: 422, code: 'CODE_INVALID' });
    expect(a.adminOtpHttpError('OTP_EXPIRED')).toEqual({ status: 422, code: 'CODE_EXPIRED' });
    expect(a.adminOtpHttpError('OTP_REQUIRED')).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
      field: { path: 'otp', code: 'OTP_REQUIRED' },
    });
    expect(a.adminOtpHttpError('AMOUNT_MISMATCH')).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
      field: { path: 'confirmAmountTiyin', code: 'AMOUNT_MISMATCH' },
    });
    expect(a.adminOtpHttpError('OTP_LOCKED')).toMatchObject({ field: { code: 'OTP_LOCKED' } });
    expect(a.adminOtpHttpError('OTP_UNAVAILABLE')).toMatchObject({
      field: { code: 'OTP_UNAVAILABLE' },
    });
  });
});
