import { describe, expect, it } from 'vitest';
import { ADMIN_AUDIT_ACTIONS } from './admin-audit-actions';
import { AdminConfirmationBodySchema } from './admin-confirm-schemas';
import {
  adminMayPerform,
  adminOtpRequired,
  canOperatorRefund,
  permissionsFor,
  roleHas,
} from './admin-permission-checks';
import {
  ADMIN_PERMISSIONS,
  ADMIN_PERMISSION_KEYS,
  type AdminPermission,
} from './admin-permissions';
import { ADMIN_AUTH_ROUTES, ADMIN_OTP_PERMISSIONS } from './admin-route-lists';
import { ADMIN_ROLES, type AdminRole } from './admin-roles';

const writesOf = (role: AdminRole): AdminPermission[] =>
  permissionsFor(role).filter((key) => ADMIN_PERMISSIONS[key].write);
const readsOf = (role: AdminRole): AdminPermission[] =>
  permissionsFor(role).filter((key) => !ADMIN_PERMISSIONS[key].write);

describe('admin role matrix (D-63 (3))', () => {
  it('lets SUPPORT write nothing but notes', () => {
    expect(writesOf('SUPPORT')).toEqual(['orders.note', 'users.note']);
  });

  it('gives OPERATOR exactly the D-63 (3) actions, without unblock (D-65 D2)', () => {
    expect(writesOf('OPERATOR').sort()).toEqual(
      [
        'orders.note',
        'users.note',
        'orders.retry',
        'orders.cancel',
        'orders.failAndRefund',
        'users.block',
        'users.freeze',
        'users.sessionsRevoke',
        'confirmations.create',
      ].sort(),
    );
  });

  it('gives OWNER every permission', () => {
    expect(permissionsFor('OWNER')).toEqual([...ADMIN_PERMISSION_KEYS]);
  });

  it('lets SUPPORT read orders, users and payments only, and keeps OWNER-only reads from OPERATOR', () => {
    expect(readsOf('SUPPORT').sort()).toEqual(['orders.read', 'payments.read', 'users.read']);
    const operatorReads = readsOf('OPERATOR');
    expect(operatorReads).toEqual(
      expect.arrayContaining([
        'audit.read',
        'infra.read',
        'dashboard.read',
        'catalog.read',
        'settings.read',
      ]),
    );
    for (const ownerOnly of [
      'audit.export',
      'admins.read',
      'payments.bankMessageRaw',
      'payments.creditPreview',
      'audit.ipFull',
    ] as const) {
      expect(roleHas('OPERATOR', ownerOnly), ownerOnly).toBe(false);
      expect(roleHas('OWNER', ownerOnly), ownerOnly).toBe(true);
    }
    expect(roleHas('SUPPORT', 'users.phoneFull')).toBe(false);
    expect(roleHas('OPERATOR', 'users.phoneFull')).toBe(true);
  });

  it('puts the operator money limit only on cancel and fail-and-refund', () => {
    const limited = ADMIN_PERMISSION_KEYS.filter((key) => ADMIN_PERMISSIONS[key].operatorLimit);
    expect(limited).toEqual(['orders.cancel', 'orders.failAndRefund']);
  });

  it('gives every write a route and an audit action (the code issuer excepted)', () => {
    for (const key of ADMIN_PERMISSION_KEYS) {
      const rule = ADMIN_PERMISSIONS[key];
      if (!rule.write) continue;
      expect(rule.routes.length, key).toBe(1);
      expect(rule.routes[0]?.method, key).not.toBe('GET');
      if (key !== 'confirmations.create') expect(rule.auditActions.length, key).toBeGreaterThan(0);
    }
    expect(ADMIN_PERMISSIONS['confirmations.create'].auditActions).toEqual([]);
  });

  it('maps every admin audit action to a route, and only known actions', () => {
    const fromMatrix = ADMIN_PERMISSION_KEYS.flatMap((key) => ADMIN_PERMISSIONS[key].auditActions);
    const fromAuth = ADMIN_AUTH_ROUTES.flatMap((r) =>
      r.auditAction === null ? [] : [r.auditAction],
    );
    const all = [...fromMatrix, ...fromAuth];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ADMIN_AUDIT_ACTIONS].sort());
  });

  it('lists every admin route once, under /admin/', () => {
    const routes = [
      ...ADMIN_PERMISSION_KEYS.flatMap((key) => ADMIN_PERMISSIONS[key].routes),
      ...ADMIN_AUTH_ROUTES,
    ].map((r) => `${r.method} ${r.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    for (const route of routes) expect(route).toMatch(/^(GET|POST|PATCH) \/admin\/[a-z0-9/:.-]+$/);
  });

  it('derives the OTP action list and the code issuer roles from the matrix', () => {
    const needOtp = ADMIN_PERMISSION_KEYS.filter((key) => ADMIN_PERMISSIONS[key].otp !== 'NEVER');
    expect([...ADMIN_OTP_PERMISSIONS].sort()).toEqual([...needOtp].sort());
    const holders = new Set(ADMIN_OTP_PERMISSIONS.flatMap((key) => ADMIN_PERMISSIONS[key].roles));
    expect([...ADMIN_PERMISSIONS['confirmations.create'].roles].sort()).toEqual(
      [...holders].sort(),
    );
    const actions = AdminConfirmationBodySchema.options.map((option) => option.shape.action.value);
    expect([...actions].sort()).toEqual([...ADMIN_OTP_PERMISSIONS].sort());
  });

  it('asks the code always for admin management and a retire, never for notes, pause or retry', () => {
    for (const key of [
      'admins.create',
      'admins.update',
      'admins.sessionsRevoke',
      'sessions.revoke',
      'cards.retire',
    ] as const) {
      expect(ADMIN_PERMISSIONS[key].otp, key).toBe('ALWAYS');
    }
    for (const key of ['orders.note', 'cards.pause', 'orders.retry'] as const) {
      expect(ADMIN_PERMISSIONS[key].otp, key).toBe('NEVER');
    }
    // A limit asks only when it is lowered (the server's rule verdict, owner decision 2026-11-18).
    expect(ADMIN_PERMISSIONS['cards.limit'].otp).toBe('RULE');
  });
});

describe('canOperatorRefund', () => {
  const limit = 50_000_000n;
  it('allows the limit itself and refuses one tiyin more', () => {
    expect(canOperatorRefund(limit, limit)).toBe(true);
    expect(canOperatorRefund(limit + 1n, limit)).toBe(false);
    expect(canOperatorRefund(limit - 1n, limit)).toBe(true);
  });
});

describe('adminMayPerform', () => {
  const ctx = (totalTiyin: bigint, holds: { attemptCap?: boolean; noPurchase?: boolean } = {}) => ({
    totalTiyin,
    operatorLimitTiyin: 50_000_000n,
    attemptCapHold: holds.attemptCap ?? false,
    noPurchaseHold: holds.noPurchase ?? false,
  });

  it('limits OPERATOR by the order total and fails closed without it', () => {
    expect(adminMayPerform('OPERATOR', 'orders.cancel', ctx(50_000_000n))).toBe(true);
    expect(adminMayPerform('OPERATOR', 'orders.cancel', ctx(50_000_001n))).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.failAndRefund', ctx(50_000_001n))).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.cancel')).toBe(false);
  });

  it('does not limit OWNER, and refuses roles without the permission', () => {
    expect(adminMayPerform('OWNER', 'orders.cancel', ctx(9_000_000_000n))).toBe(true);
    expect(adminMayPerform('OWNER', 'orders.cancel')).toBe(true);
    expect(adminMayPerform('SUPPORT', 'orders.cancel', ctx(1n))).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.refund', ctx(1n))).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.retry', ctx(9_000_000_000n))).toBe(true);
    expect(adminMayPerform('OWNER', 'orders.retry')).toBe(true);
  });

  it('keeps the attempt cap and NO_PURCHASE holds OWNER-only (M-1, D-64 (6))', () => {
    const cap = ctx(1n, { attemptCap: true });
    const noPurchase = ctx(1n, { noPurchase: true });
    expect(adminMayPerform('OPERATOR', 'orders.retry', cap)).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.retry', noPurchase)).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.retry')).toBe(false);
    // The attempt cap blocks only a retry: cancelling the order stays within OPERATOR's limit.
    expect(adminMayPerform('OPERATOR', 'orders.cancel', cap)).toBe(true);
    expect(adminMayPerform('OPERATOR', 'orders.cancel', noPurchase)).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.failAndRefund', noPurchase)).toBe(false);
    expect(adminMayPerform('OPERATOR', 'orders.note', noPurchase)).toBe(true);
    for (const key of ['orders.retry', 'orders.cancel', 'orders.failAndRefund'] as const) {
      expect(adminMayPerform('OWNER', key, ctx(1n, { attemptCap: true, noPurchase: true }))).toBe(
        true,
      );
    }
    expect(ADMIN_PERMISSIONS['orders.retry'].ownerOnlyHolds).toEqual([
      'ATTEMPT_CAP',
      'NO_PURCHASE',
    ]);
  });

  it('agrees with roleHas for every role and permission without a limit or a hold', () => {
    for (const role of ADMIN_ROLES) {
      for (const key of ADMIN_PERMISSION_KEYS) {
        const rule = ADMIN_PERMISSIONS[key];
        if (rule.operatorLimit || rule.ownerOnlyHolds.length > 0) continue;
        expect(adminMayPerform(role, key), `${role} ${key}`).toBe(roleHas(role, key));
      }
    }
  });
});

describe('adminOtpRequired', () => {
  const thresholdTiyin = 100_000_000n;

  it('needs the code only above the threshold for money actions (by magnitude)', () => {
    const at = { amountTiyin: thresholdTiyin, thresholdTiyin, codelessBudgetExceeded: false };
    const above = {
      amountTiyin: thresholdTiyin + 1n,
      thresholdTiyin,
      codelessBudgetExceeded: false,
    };
    expect(adminOtpRequired('payments.reverse', at)).toBe(false);
    expect(adminOtpRequired('payments.reverse', above)).toBe(true);
    expect(adminOtpRequired('orders.cancel', at)).toBe(false);
    expect(adminOtpRequired('orders.cancel', above)).toBe(true);
    expect(adminOtpRequired('payments.reverse', { thresholdTiyin })).toBe(true);
  });

  it('always needs it for a DELIVERED refund and a credit, a debit only above the threshold (D-65 D1)', () => {
    expect(adminOtpRequired('orders.refund', { amountTiyin: 1n, thresholdTiyin })).toBe(true);
    expect(adminOtpRequired('users.adjustWallet', { amountTiyin: 1n, thresholdTiyin })).toBe(true);
    expect(
      adminOtpRequired('users.adjustWallet', {
        amountTiyin: -thresholdTiyin,
        thresholdTiyin,
        codelessBudgetExceeded: false,
      }),
    ).toBe(false);
    expect(
      adminOtpRequired('users.adjustWallet', {
        amountTiyin: -(thresholdTiyin + 1n),
        thresholdTiyin,
      }),
    ).toBe(true);
    expect(adminOtpRequired('users.adjustWallet', { thresholdTiyin })).toBe(true);
  });

  it('a codeless debit or reversal past the daily budget needs it; unknown budget asks (fail closed)', () => {
    const small = { amountTiyin: -1n, thresholdTiyin };
    for (const key of ['users.adjustWallet', 'payments.reverse'] as const) {
      expect(adminOtpRequired(key, { ...small, codelessBudgetExceeded: true }), key).toBe(true);
      expect(adminOtpRequired(key, { ...small, codelessBudgetExceeded: false }), key).toBe(false);
      expect(adminOtpRequired(key, small), key).toBe(true);
    }
    // The budget does not touch other money actions (orders keep their threshold rule).
    expect(adminOtpRequired('orders.cancel', { amountTiyin: 1n, thresholdTiyin })).toBe(false);
  });

  it('asks it to lift a SECURITY card pause only (D-65 D3)', () => {
    expect(adminOtpRequired('cards.resume', { thresholdTiyin, ruleRequiresCode: true })).toBe(true);
    expect(adminOtpRequired('cards.resume', { thresholdTiyin, ruleRequiresCode: false })).toBe(
      false,
    );
  });

  it('follows the domain rule for resolve and FX, failing closed when unknown', () => {
    const small = { amountTiyin: 1n, thresholdTiyin };
    expect(adminOtpRequired('orders.resolve', { ...small, ruleRequiresCode: false })).toBe(false);
    expect(adminOtpRequired('orders.resolve', { ...small, ruleRequiresCode: true })).toBe(true);
    expect(adminOtpRequired('orders.resolve', small)).toBe(true);
    expect(
      adminOtpRequired('orders.resolve', {
        amountTiyin: thresholdTiyin + 1n,
        thresholdTiyin,
        ruleRequiresCode: false,
      }),
    ).toBe(true);
    expect(adminOtpRequired('fx.set', { thresholdTiyin, ruleRequiresCode: false })).toBe(false);
    expect(adminOtpRequired('fx.set', { thresholdTiyin })).toBe(true);
  });

  it('always asks for admin management and never for a note', () => {
    expect(adminOtpRequired('admins.create', { thresholdTiyin })).toBe(true);
    expect(adminOtpRequired('orders.note', { thresholdTiyin })).toBe(false);
  });
});
