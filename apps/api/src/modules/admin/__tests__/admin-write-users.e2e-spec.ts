import { randomUUID } from 'node:crypto';
import { ACCESS_COOKIE_NAME, AdminUserStateResponseSchema } from '@repo/shared';
import { lockWallet } from '@repo/db';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf } from './admin-write.e2e-kit';

// Phase 9 S6: the admin's account actions on a user (docs/04 «Foydalanuvchilar», D-63 (9), Q20).
const t = useAdminE2e();
const kit = adminWriteKit(t);
const REASON = { reason: 'abuse report checked' };

/** A store user signed in on the web: its id and its access cookie. */
async function webUser(): Promise<{ id: string; cookie: string }> {
  const access = await t.loginUser();
  const [body] = access.split('.');
  const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as {
    sub: string;
  };
  return { id: payload.sub, cookie: `${ACCESS_COOKIE_NAME}=${access}` };
}

const liveSessions = (userId: string) =>
  t.db().webSession.count({ where: { userId, revokedAt: null } });

describe('admin user actions (S6)', () => {
  it('block: wallet lock, every web session ended in the same tx, USER_BLOCKED on the next request, ADMIN audit, alert', async () => {
    const operator = await kit.session('OPERATOR');
    const user = await webUser();
    expect(await liveSessions(user.id)).toBeGreaterThan(0);
    const key = randomUUID();

    const res = await kit.post(operator, `users/${user.id}/block`, REASON, key);
    expect(res.statusCode).toBe(200);
    const state = AdminUserStateResponseSchema.parse(dataOf(res));
    expect(state).toMatchObject({ userId: user.id, isBlocked: true, applied: true });
    expect(state.revokedSessions).toBeGreaterThan(0);
    expect(await liveSessions(user.id)).toBe(0);
    // The web session is gone (401); a Mini App token has no session and meets USER_BLOCKED.
    const web = await t.request('GET', '/api/v1/me', { cookie: user.cookie });
    expect(web.statusCode).toBe(401);
    const tg = await t.request('GET', '/api/v1/me', kit.miniApp(user.id));
    expect(tg.statusCode).toBe(403);
    expect(errorOf(tg).code).toBe('USER_BLOCKED');

    const audit = await t.db().auditLog.findUniqueOrThrow({ where: { id: state.auditId ?? '' } });
    expect(audit).toMatchObject({
      actorType: 'ADMIN',
      actorId: operator.admin.id,
      action: 'USER_BLOCK',
      targetType: 'User',
      targetId: user.id,
      reason: REASON.reason,
    });
    expect(audit.after).toMatchObject({ isBlocked: true, adminRole: 'OPERATOR' });
    expect(await kit.alerts('adminAction', audit.id)).toBe(1);

    // The same key and body: the first answer, nothing written again.
    const again = await kit.post(operator, `users/${user.id}/block`, REASON, key);
    expect(dataOf(again)).toMatchObject({ auditId: audit.id, applied: false, isBlocked: true });
    // The same key, another body: 409.
    const other = await kit.post(
      operator,
      `users/${user.id}/block`,
      { reason: 'another reason here' },
      key,
    );
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      await t.db().auditLog.count({ where: { targetId: user.id, action: 'USER_BLOCK' } }),
    ).toBe(1);
  });

  it('block waits for a purchase holding the wallet lock, and is refused to SUPPORT (404)', async () => {
    const operator = await kit.session('OPERATOR');
    const support = await kit.session('SUPPORT');
    const userId = await kit.user();
    expect((await kit.post(support, `users/${userId}/block`, REASON)).statusCode).toBe(404);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const purchase = t.db().$transaction(
      async (tx) => {
        await lockWallet(tx, userId);
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    let done = false;
    const block = kit.post(operator, `users/${userId}/block`, REASON).then((res) => {
      done = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(done).toBe(false); // waiting for the purchase's wallet lock
    release();
    await purchase;
    expect((await block).statusCode).toBe(200);
  });

  it('unblock and unfreeze are OWNER only; freeze is OPERATOR+; a no-op writes nothing', async () => {
    const owner = await kit.session('OWNER');
    const operator = await kit.session('OPERATOR');
    const userId = await kit.user();
    expect((await kit.post(operator, `users/${userId}/freeze`, REASON)).statusCode).toBe(200);
    const twice = await kit.post(operator, `users/${userId}/freeze`, REASON);
    expect(dataOf(twice)).toMatchObject({ purchaseFrozen: true, applied: false, auditId: null });
    expect((await kit.post(operator, `users/${userId}/unfreeze`, REASON)).statusCode).toBe(404);
    expect((await kit.post(operator, `users/${userId}/unblock`, REASON)).statusCode).toBe(404);
    const unfreeze = await kit.post(owner, `users/${userId}/unfreeze`, REASON);
    expect(dataOf(unfreeze)).toMatchObject({ purchaseFrozen: false, applied: true });
    const row = await t.db().auditLog.findUniqueOrThrow({
      where: { id: dataOf<{ auditId: string }>(unfreeze).auditId },
    });
    expect(row).toMatchObject({
      actorType: 'ADMIN',
      actorId: owner.admin.id,
      action: 'USER_UNFREEZE',
    });
    expect((await kit.post(owner, `users/${userId}/unblock`, REASON)).json()).toMatchObject({
      data: { isBlocked: false, applied: false, auditId: null },
    });
  });

  it('sessions/revoke always writes its row; a deactivated admin is refused inside the transaction (TOCTOU)', async () => {
    const operator = await kit.session('OPERATOR');
    const user = await webUser();
    const res = await kit.post(operator, `users/${user.id}/sessions/revoke`, REASON);
    expect(dataOf(res)).toMatchObject({ userId: user.id, applied: true });
    expect(await liveSessions(user.id)).toBe(0);

    // The guard read the admin as active; the deactivation commits while the action waits on
    // the admin row (FOR SHARE): the action must see it and write nothing.
    const victim = await kit.user();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const deactivate = t.db().$transaction(
      async (tx) => {
        await tx.adminUser.update({ where: { id: operator.admin.id }, data: { isActive: false } });
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const late = kit.post(operator, `users/${victim}/block`, REASON);
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await deactivate;
    expect((await late).statusCode).toBe(404);
    expect(await t.db().auditLog.count({ where: { targetId: victim, action: 'USER_BLOCK' } })).toBe(
      0,
    );
    expect((await t.db().user.findUniqueOrThrow({ where: { id: victim } })).isBlocked).toBe(false);
  });

  it('notes: every role writes; an OPERATOR reads the note text in the audit log (SA-S4-7)', async () => {
    const support = await kit.session('SUPPORT');
    const operator = await kit.session('OPERATOR');
    const userId = await kit.user();
    const res = await kit.post(support, `users/${userId}/notes`, { text: 'called, no answer' });
    expect(res.statusCode).toBe(200);
    const { auditId, note } = dataOf<{
      auditId: string;
      note: { text: string; author: { id: string } };
    }>(res);
    expect(note).toMatchObject({ text: 'called, no answer', author: { id: support.admin.id } });
    const detail = await t.request(
      'GET',
      `/api/v1/admin/users/${userId}`,
      t.spa({ cookie: operator.cookie }),
    );
    expect(dataOf<{ notes: { id: string; text: string }[] }>(detail).notes[0]).toMatchObject({
      id: auditId,
      text: 'called, no answer',
    });
    const audit = await t.request(
      'GET',
      `/api/v1/admin/audit-log?targetId=${userId}`,
      t.spa({ cookie: operator.cookie }),
    );
    const rows = dataOf<{ id: string; after: { text: unknown } | null }[]>(audit);
    expect(rows.find((row) => row.id === auditId)?.after?.text).toBe('called, no answer');
  });
});
