import { randomUUID } from 'node:crypto';
import { AdminWriteKeyVoidResponseSchema, CSRF_HEADER } from '@repo/shared';
import { adminAuditIdFor } from '../write/admin-write-key';
import { useAdminE2e } from './admin-e2e.harness';
import { heldTransaction, waitForLockWaiter } from './admin-e2e.locks';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// 9-B SA-1: `POST /admin/write-keys/void` (docs/04 «Kalitni bekor qilish»): who may call it, its
// body, the tombstone it writes, VOIDED / APPLIED, its limit, and that it touches only the
// caller's own key. Races: admin-write-void-races.e2e-spec.ts; every route: -routes.e2e-spec.ts.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const PATH = 'write-keys/void';

const voidBody = (key: string, targetId: string, action = 'users.note') => ({
  idempotencyKey: key,
  action,
  targetId,
});
const callVoid = (who: Session, body: object) => kit.post(who, PATH, body, null);
const note = (who: Session, userId: string, key: string) =>
  kit.post(who, `users/${userId}/notes`, { text: 'void e2e note' }, key);

describe('POST /admin/write-keys/void', () => {
  it('every role voids its own key: VOIDED, the tombstone row, again VOIDED, one row', async () => {
    const userId = await kit.user();
    for (const role of ['OWNER', 'OPERATOR', 'SUPPORT'] as const) {
      const who = await kit.session(role);
      const key = randomUUID();
      const res = await callVoid(who, voidBody(key, userId, 'users.note'));
      expect(res.statusCode).toBe(200);
      const answer = AdminWriteKeyVoidResponseSchema.parse(dataOf(res));
      const auditId = adminAuditIdFor(who.admin.id, key);
      expect(answer).toMatchObject({ status: 'VOIDED', auditId });

      const row = await t.db().auditLog.findUniqueOrThrow({ where: { id: auditId } });
      const session = await t.db().adminSession.findFirstOrThrow({
        where: { adminId: who.admin.id },
      });
      expect(row).toMatchObject({
        actorType: 'ADMIN',
        actorId: who.admin.id,
        action: 'IDEMPOTENCY_VOID',
        targetType: 'User',
        targetId: userId,
        before: null,
        reason: null,
      });
      expect(row.ip).not.toBeNull();
      expect(row.after).toEqual({
        voidedAction: 'users.note',
        adminRole: role,
        sessionId: session.id,
      });
      expect(JSON.stringify(row)).not.toContain(key);
      expect(JSON.stringify(row)).not.toMatch(/requestHash/i);
      expect(answer.at).toBe(row.createdAt.toISOString());

      const again = await callVoid(who, voidBody(key, userId, 'users.note'));
      expect(dataOf(again)).toEqual(answer);
      expect(await t.db().auditLog.count({ where: { id: auditId } })).toBe(1);
    }
  });

  it('a key whose action committed is APPLIED with that row; the action is not undone', async () => {
    const support = await kit.session('SUPPORT');
    const userId = await kit.user();
    const key = randomUUID();
    const done = await note(support, userId, key);
    expect(done.statusCode).toBe(200);
    const { auditId } = dataOf<{ auditId: string }>(done);
    const res = await callVoid(support, voidBody(key, userId));
    expect(res.statusCode).toBe(200);
    const row = await t.db().auditLog.findUniqueOrThrow({ where: { id: auditId } });
    expect(dataOf(res)).toEqual({
      status: 'APPLIED',
      auditId,
      action: 'USER_NOTE',
      at: row.createdAt.toISOString(),
    });
    expect(row.action).toBe('USER_NOTE');
    // The replay of the action still answers (the key was not voided).
    const replay = await note(support, userId, key);
    expect(dataOf(replay)).toMatchObject({ auditId, applied: false });
  });

  it('SA-9B1-3: a role voids only keys of actions it may perform; else 404 and no row', async () => {
    const userId = await kit.user();
    for (const [role, action] of [
      ['SUPPORT', 'users.adjustWallet'],
      ['SUPPORT', 'users.block'],
      ['OPERATOR', 'users.adjustWallet'],
      ['OPERATOR', 'catalog.productUpdate'],
    ] as const) {
      const who = await kit.session(role);
      const key = randomUUID();
      const res = await callVoid(who, voidBody(key, userId, action));
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
      const tombstone = adminAuditIdFor(who.admin.id, key);
      expect(await t.db().auditLog.count({ where: { id: tombstone } })).toBe(0);
    }
    // The same OPERATOR session may void a key of its own kind of action.
    const operator = await kit.session('OPERATOR');
    const ok = await callVoid(operator, voidBody(randomUUID(), userId, 'orders.cancel'));
    expect(dataOf(ok)).toMatchObject({ status: 'VOIDED' });
  });

  it('another admin voiding the same key string writes its own tombstone; the first admin acts', async () => {
    const [a, b] = [await kit.session('OPERATOR'), await kit.session('SUPPORT')];
    const userId = await kit.user();
    const key = randomUUID();
    const byB = await callVoid(b, voidBody(key, userId));
    expect(dataOf(byB)).toMatchObject({
      status: 'VOIDED',
      auditId: adminAuditIdFor(b.admin.id, key),
    });
    const byA = await note(a, userId, key);
    expect(byA.statusCode).toBe(200);
    expect(dataOf(byA)).toMatchObject({
      auditId: adminAuditIdFor(a.admin.id, key),
      applied: true,
    });
  });

  it('takes no Idempotency-Key header, and a header changes nothing', async () => {
    const who = await kit.session('SUPPORT');
    const key = randomUUID();
    const withHeader = await kit.post(who, PATH, voidBody(key, 'u1'), randomUUID());
    expect(dataOf(withHeader)).toMatchObject({
      status: 'VOIDED',
      auditId: adminAuditIdFor(who.admin.id, key),
    });
  });

  it('refuses a bad body with 400 and writes nothing', async () => {
    const who = await kit.session('OWNER');
    const key = randomUUID();
    const bad = [
      { ...voidBody(key, 'u1'), extra: true },
      voidBody(key, 'u1', 'confirmations.create'),
      voidBody(key, 'u1', 'writeKeys.void'),
      voidBody(key, 'u1', 'users.read'),
      voidBody('short', 'u1'),
      voidBody(key, '../u1'),
      { idempotencyKey: key, action: 'users.note' },
    ];
    for (const body of bad) {
      const res = await callVoid(who, body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    const tombstone = adminAuditIdFor(who.admin.id, key);
    expect(await t.db().auditLog.count({ where: { id: tombstone } })).toBe(0);
  });

  it('404 without a session, without the CSRF header, from another origin, or a deactivated admin', async () => {
    const who = await kit.session('OPERATOR');
    const key = randomUUID();
    const body = voidBody(key, 'u1');
    const url = `/api/v1/admin/${PATH}`;
    const spa = t.spa({ cookie: who.cookie });
    const noCsrf = Object.fromEntries(Object.entries(spa).filter(([name]) => name !== CSRF_HEADER));
    const refused = [
      await t.request('POST', url, t.spa(), undefined, body),
      await t.request('POST', url, noCsrf, undefined, body),
      await t.request(
        'POST',
        url,
        t.spa({ cookie: who.cookie, origin: t.env.WEB_URL }),
        undefined,
        body,
      ),
    ];
    await t.db().adminUser.update({ where: { id: who.admin.id }, data: { isActive: false } });
    refused.push(await callVoid(who, body));
    expect(refused.map((res) => res.statusCode)).toEqual([404, 404, 404, 404]);
    const tombstone = adminAuditIdFor(who.admin.id, key);
    expect(await t.db().auditLog.count({ where: { id: tombstone } })).toBe(0);
  });

  it('re-checks the admin in its transaction: deactivated after the guard -> 404, no tombstone', async () => {
    const who = await kit.session('OWNER');
    const key = randomUUID();
    // The guard reads the committed row (active) and lets the call in; the deactivation commits
    // while the void waits for its FOR SHARE on the admin row.
    const holder = await heldTransaction(t.db(), (tx) =>
      tx.adminUser.update({ where: { id: who.admin.id }, data: { isActive: false } }),
    );
    let settled = false;
    const voiding = callVoid(who, voidBody(key, 'u1')).finally(() => {
      settled = true;
    });
    const waited = await waitForLockWaiter(t.db(), '%"AdminUser"%FOR SHARE%', () => settled);
    await holder.commit();
    const res = await voiding;
    expect(waited).toBe(true);
    expect(res.statusCode).toBe(404);
    const tombstone = adminAuditIdFor(who.admin.id, key);
    expect(await t.db().auditLog.count({ where: { id: tombstone } })).toBe(0);
  });

  it('counts against the write limit: the 31st write of a minute is 429 with Retry-After', async () => {
    const who = await kit.session('SUPPORT');
    for (let i = 0; i < 30; i += 1) {
      const res = await callVoid(who, voidBody(randomUUID(), 'u1'));
      expect(res.statusCode).toBe(200);
    }
    const over = await callVoid(who, voidBody(randomUUID(), 'u1'));
    expect(over.statusCode).toBe(429);
    expect(errorOf(over).code).toBe('RATE_LIMITED');
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('the tombstone is in the audit log under IDEMPOTENCY_VOID', async () => {
    const owner = await kit.session('OWNER');
    const key = randomUUID();
    await callVoid(owner, voidBody(key, 'u1', 'cards.pause'));
    const auditId = adminAuditIdFor(owner.admin.id, key);
    const res = await t.request(
      'GET',
      `/api/v1/admin/audit-log?action=IDEMPOTENCY_VOID&actorId=${owner.admin.id}`,
      t.spa({ cookie: owner.cookie }),
    );
    expect(res.statusCode).toBe(200);
    const rows = dataOf<{ id: string; action: string; targetType: string; after: unknown }[]>(res);
    expect(rows.find((row) => row.id === auditId)).toMatchObject({
      action: 'IDEMPOTENCY_VOID',
      targetType: 'TopupCard',
      after: { voidedAction: 'cards.pause', adminRole: 'OWNER' },
    });
  });
});
