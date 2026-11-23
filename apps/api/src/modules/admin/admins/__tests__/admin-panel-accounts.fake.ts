import type { AdminUser } from '@repo/db';
import type { AdminUpdateBody } from '@repo/shared';
import type { AdminActor } from '../../../../common/admin/audit-actor';
import type { AdminLoginRequestRepository } from '../../auth/admin-login-request.repository';
import type { AdminSessionRepository } from '../../auth/admin-session.repository';
import { AdminPanelAccountsService } from '../admin-panel-accounts.service';
import type { AdminUsersRepository } from '../admin-users.repository';

// The fakes of AdminPanelAccountsService's unit specs: every repository call is logged in order.

export const NOW = new Date('2026-11-23T09:00:00.000Z');
export const ACTOR_ID = 'cmowner00000000000000001';
export const TARGET_ID = 'cmtarget0000000000000001';
export const SESSION_ID = 'cmsession000000000000001';
export const REASON = 'rotation of the support shift';

export function row(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: TARGET_ID,
    telegramId: 1234567890n,
    name: 'Operator',
    role: 'OPERATOR',
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export function setup(target: AdminUser | null = row(), opts: { stepUp?: boolean } = {}) {
  const calls: string[] = [];
  const audits: { action: string; before: unknown; after: Record<string, unknown> }[] = [];
  const tx = {
    $queryRaw: () => {
      calls.push('actor FOR SHARE');
      return Promise.resolve([{ id: ACTOR_ID, role: 'OWNER', isActive: true }]);
    },
    adminSession: {
      findUnique: () =>
        Promise.resolve({ adminId: ACTOR_ID, revokedAt: null, expiresAt: new Date(2e12) }),
    },
  };
  const admins = {
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    findByTelegramId: jest.fn().mockResolvedValue(null),
    // The unlocked read of update()'s early OWNER check (not logged: it takes no lock).
    findById: jest.fn(() => Promise.resolve(target)),
    create: jest.fn().mockResolvedValue(row({ id: 'cmnew0000000000000000001' })),
    lockById: jest.fn((_tx: unknown, _id: string, mode: string) => {
      calls.push(`target ${mode}`);
      return Promise.resolve(target);
    }),
    updateNonOwner: jest.fn(() => {
      calls.push('update');
      return Promise.resolve(true);
    }),
    account: jest.fn(() => Promise.resolve({ ...row(), activeSessions: 0, lastLoginAt: null })),
    createAudit: jest.fn((_tx: unknown, data: (typeof audits)[number]) => {
      calls.push('audit');
      audits.push(data);
      return Promise.resolve('audit');
    }),
  };
  const sessions = {
    lockAdminSessions: jest.fn(() => {
      calls.push('sessions lock');
      return Promise.resolve();
    }),
    revokeAllOf: jest.fn(() => {
      calls.push('sessions');
      return Promise.resolve(2);
    }),
    revokeOne: jest.fn(() => {
      calls.push('session');
      return Promise.resolve(true);
    }),
    findById: jest.fn().mockResolvedValue({ id: SESSION_ID, adminId: TARGET_ID }),
  };
  const codes = {
    expireOpenOf: jest.fn(() => {
      calls.push('codes');
      return Promise.resolve(1);
    }),
  };
  const alerts = {
    adminAction: jest.fn(() => {
      calls.push('alert');
      return Promise.resolve(true);
    }),
  };
  const service = new AdminPanelAccountsService(
    admins as unknown as AdminUsersRepository,
    sessions as unknown as AdminSessionRepository,
    codes as unknown as AdminLoginRequestRepository,
    alerts,
    { ADMIN_TELEGRAM_IDS: [1234567890n] },
    { now: () => NOW },
  );
  const actor: AdminActor = {
    kind: 'ADMIN',
    adminId: ACTOR_ID,
    sessionId: 'cmactorsession0000000001',
    ip: '203.0.113.7',
    permission: 'admins.update',
    request: { auditId: 'a0123456789abcdef0123456789abcde', requestHash: 'h' },
    ...(opts.stepUp === false
      ? {}
      : {
          stepUp: {
            verify: () => {
              calls.push('otp');
              return Promise.resolve();
            },
          },
        }),
  };
  return { service, actor, calls, audits, admins, sessions, codes, alerts };
}

export const OTP = { challengeId: 'c', code: '1' };
/** What every row carries besides its own fields: the code and the actor (S2-6, D-46). */
export const WHO = {
  otpVerified: true,
  adminRole: 'OWNER',
  requestHash: 'h',
  sessionId: 'cmactorsession0000000001',
};
export const body = (over: Partial<AdminUpdateBody>): AdminUpdateBody => ({
  reason: REASON,
  otp: OTP,
  ...over,
});
