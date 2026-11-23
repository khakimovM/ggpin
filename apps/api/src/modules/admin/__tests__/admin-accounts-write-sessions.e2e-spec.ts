import { randomUUID } from 'node:crypto';
import { AdminSessionsRevokeResponseSchema } from '@repo/shared';
import { AdminPanelAccountsService } from '../admins/admin-panel-accounts.service';
import { hashAdminToken } from '../auth/admin-session.service';
import { REASON, adminAccountsKit } from './admin-accounts-write.e2e-kit';
import { useAdminE2e } from './admin-e2e.harness';
import { dataOf } from './admin-write.e2e-kit';

// Phase 9 S9a: ending admin sessions from the panel (docs/04 «Adminlar», Q7 b): the cookie of
// the caller's own ended session is cleared, an OWNER's session may be ended (code + alert).
const t = useAdminE2e();
const kit = adminAccountsKit(t);
const OTP_SHAPE = { challengeId: '0'.repeat(32), code: '123456' };

describe('admin session ends (S9a)', () => {
  it('ending one’s own sessions clears the cookie (currentRevoked) and the next request is 404', async () => {
    const owner = await kit.session('OWNER');
    const id = owner.admin.id;
    const res = await kit.withCode(
      'POST',
      owner,
      `admins/${id}/sessions/revoke`,
      { action: 'admins.sessionsRevoke', targetId: id },
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(AdminSessionsRevokeResponseSchema.parse(dataOf(res))).toMatchObject({
      revokedSessions: 1,
      currentRevoked: true,
      applied: true,
    });
    expect(kit.clearedCookie(res)).toBe(true);
    expect(await kit.me(owner.cookie)).toBe(404);
  });

  it('Q7 b: an OWNER ends another OWNER’s session with the code; audit and alert; that session only', async () => {
    const owner = await kit.session('OWNER');
    const victim = await kit.session('OWNER');
    const second = await t.login(victim.admin);
    // By its token: both sessions share the fixed test clock's createdAt.
    const { id: sessionId } = await t.db().adminSession.findUniqueOrThrow({
      where: { tokenHash: hashAdminToken(second.token) },
      select: { id: true },
    });
    const res = await kit.withCode(
      'POST',
      owner,
      `sessions/${sessionId}/revoke`,
      { action: 'sessions.revoke', targetId: sessionId },
      {},
    );
    expect(res.statusCode).toBe(200);
    const done = AdminSessionsRevokeResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({ revokedSessions: 1, currentRevoked: false, applied: true });
    expect(kit.clearedCookie(res)).toBe(false);
    expect(await kit.me(second.cookie)).toBe(404);
    expect(await kit.me(victim.cookie)).toBe(200);
    expect(await kit.me(owner.cookie)).toBe(200);
    const audit = await t.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId ?? '' } });
    expect(audit).toMatchObject({
      action: 'ADMIN_SESSION_REVOKE',
      targetType: 'AdminSession',
      targetId: sessionId,
    });
    expect(audit.after).toMatchObject({
      adminId: victim.admin.id,
      revokedSessions: 1,
      otpVerified: true,
    });
    expect(await kit.alerts('adminAction', audit.id)).toBe(1);
  });

  it('ending one’s own current session by its id clears the cookie', async () => {
    const owner = await kit.session('OWNER');
    const sessionId = await kit.liveSessionId(owner.admin);
    const res = await kit.withCode(
      'POST',
      owner,
      `sessions/${sessionId}/revoke`,
      { action: 'sessions.revoke', targetId: sessionId },
      {},
    );
    expect(dataOf(res)).toMatchObject({ revokedSessions: 1, currentRevoked: true });
    expect(kit.clearedCookie(res)).toBe(true);
    expect(await kit.me(owner.cookie)).toBe(404);
  });

  it('CR-4 / M-1: the same key replayed from another live session: currentRevoked false (it speaks of the caller), cookie stays, one alert', async () => {
    const owner = await kit.session('OWNER');
    const other = await t.login(owner.admin);
    const first = await t.db().adminSession.findUniqueOrThrow({
      where: { tokenHash: hashAdminToken(owner.cookie.split('=')[1] ?? '') },
      select: { id: true },
    });
    const key = randomUUID();
    const path = `sessions/${first.id}/revoke`;
    const confirmation = { action: 'sessions.revoke', targetId: first.id } as const;
    const res = await kit.withCode('POST', owner, path, confirmation, {}, key);
    const done = AdminSessionsRevokeResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({ currentRevoked: true, applied: true });
    expect(kit.clearedCookie(res)).toBe(true);

    const fromOther = { admin: owner.admin, cookie: other.cookie };
    const again = await kit.send('POST', fromOther, path, { reason: REASON, otp: OTP_SHAPE }, key);
    expect(again.statusCode).toBe(200);
    expect(dataOf(again)).toEqual({
      revokedSessions: 1,
      currentRevoked: false,
      auditId: done.auditId,
      applied: false,
    });
    expect(kit.clearedCookie(again)).toBe(false);
    expect(await kit.me(other.cookie)).toBe(200);
    expect(await kit.alerts('adminAction', done.auditId)).toBe(1);
  });

  it('M-2 (SA I-3): the call ends its own sessions, then fails past the commit: its twin answers, currentRevoked, cookie cleared', async () => {
    const owner = await kit.session('OWNER');
    const id = owner.admin.id;
    const accounts = t.app().get(AdminPanelAccountsService);
    const original = accounts.revokeAdminSessions.bind(accounts);
    // The write commits; whatever comes after it (the answer's read, the alert) fails once.
    accounts.revokeAdminSessions = async (...args) => {
      accounts.revokeAdminSessions = original;
      await original(...args);
      throw new Error('a read after the commit failed');
    };
    const res = await kit
      .withCode(
        'POST',
        owner,
        `admins/${id}/sessions/revoke`,
        { action: 'admins.sessionsRevoke', targetId: id },
        {},
      )
      .finally(() => {
        accounts.revokeAdminSessions = original;
      });
    expect(res.statusCode).toBe(200);
    const done = AdminSessionsRevokeResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({ revokedSessions: 1, currentRevoked: true, applied: false });
    expect(await t.db().auditLog.count({ where: { id: done.auditId } })).toBe(1);
    expect(kit.clearedCookie(res)).toBe(true);
    expect(await kit.me(owner.cookie)).toBe(404);
  });
});
