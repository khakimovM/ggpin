import { randomUUID } from 'node:crypto';
import { AdminAccountResponseSchema, type AdminConfirmationBody } from '@repo/shared';
import { REASON, adminAccountsKit } from './admin-accounts-write.e2e-kit';
import { useAdminE2e } from './admin-e2e.harness';
import { dataOf, errorOf } from './admin-write.e2e-kit';

// Phase 9 S9a: the panel's admin management (docs/04 «Adminlar», D-63 (4)/(6), Q7, Q8).
const t = useAdminE2e();
const kit = adminAccountsKit(t);
const OTP_SHAPE = { challengeId: '0'.repeat(32), code: '123456' };

describe('admin management writes (S9a)', () => {
  it('OPERATOR and SUPPORT: every route and its code are 404', async () => {
    const target = await t.newAdmin('SUPPORT');
    for (const role of ['OPERATOR', 'SUPPORT'] as const) {
      const who = await kit.session(role);
      const body = { reason: REASON, otp: OTP_SHAPE };
      const create = { ...body, telegramId: kit.freshTelegramId(), name: 'X', role: 'SUPPORT' };
      expect((await kit.send('POST', who, 'admins', create)).statusCode).toBe(404);
      expect(
        (await kit.send('PATCH', who, `admins/${target.id}`, { ...body, name: 'Y' })).statusCode,
      ).toBe(404);
      expect(
        (await kit.send('POST', who, `admins/${target.id}/sessions/revoke`, body)).statusCode,
      ).toBe(404);
      expect((await kit.send('POST', who, `sessions/${target.id}/revoke`, body)).statusCode).toBe(
        404,
      );
      const code = await kit.post(
        who,
        'confirmations',
        { action: 'admins.sessionsRevoke', targetId: target.id },
        null,
      );
      expect(code.statusCode).toBe(404);
    }
  });

  it('create: SUPPORT with the code, allowlisted:false, ADMIN audit, one alert; replay and 409 write nothing', async () => {
    const owner = await kit.session('OWNER');
    const telegramId = kit.freshTelegramId();
    const asked = { telegramId, name: 'Night shift', role: 'SUPPORT' } as const;
    const key = randomUUID();
    const res = await kit.withCode(
      'POST',
      owner,
      'admins',
      { action: 'admins.create', ...asked },
      asked,
      key,
    );
    await kit.track(telegramId);
    expect(res.statusCode).toBe(200);
    const done = AdminAccountResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({
      admin: {
        telegramId,
        name: 'Night shift',
        role: 'SUPPORT',
        isActive: true,
        allowlisted: false,
      },
      auditId: kit.auditIdOf(owner, key),
      applied: true,
    });
    const audit = await t.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId ?? '' } });
    expect(audit).toMatchObject({
      actorType: 'ADMIN',
      actorId: owner.admin.id,
      action: 'ADMIN_CREATE',
      targetType: 'AdminUser',
      targetId: done.admin.id,
      reason: REASON,
    });
    expect(audit.after).toMatchObject({
      role: 'SUPPORT',
      allowlisted: false,
      adminRole: 'OWNER',
      otpVerified: true,
    });
    expect(await kit.alerts('adminAction', audit.id)).toBe(1);

    // The same key and body (the used code does not matter): the first answer, no second alert.
    const again = await kit.send(
      'POST',
      owner,
      'admins',
      { ...asked, reason: REASON, otp: OTP_SHAPE },
      key,
    );
    expect(dataOf(again)).toMatchObject({
      auditId: audit.id,
      applied: false,
      admin: { id: done.admin.id },
    });
    expect(await kit.alerts('adminAction', audit.id)).toBe(1);
    const other = await kit.send(
      'POST',
      owner,
      'admins',
      { ...asked, name: 'Day shift', reason: REASON, otp: OTP_SHAPE },
      key,
    );
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await t.db().adminUser.count({ where: { telegramId: BigInt(telegramId) } })).toBe(1);
  });

  it('refusals: OWNER role 400, no code 400, a code for another body 422, a taken id 400 ADMIN_EXISTS', async () => {
    const owner = await kit.session('OWNER');
    const telegramId = kit.freshTelegramId();
    const asked = { telegramId, name: 'Shift', role: 'SUPPORT' } as const;
    const owned = await kit.send('POST', owner, 'admins', {
      ...asked,
      role: 'OWNER',
      reason: REASON,
      otp: OTP_SHAPE,
    });
    expect(owned.statusCode).toBe(400);
    expect(errorOf(owned).details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'role' })]),
    );
    const bare = await kit.send('POST', owner, 'admins', { ...asked, reason: REASON });
    expect(bare.statusCode).toBe(400);
    expect(errorOf(bare).details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'otp' })]),
    );

    const confirmation: AdminConfirmationBody = { action: 'admins.create', ...asked };
    const wrong = await kit.withCode('POST', owner, 'admins', confirmation, {
      ...asked,
      name: 'Other',
    });
    expect(wrong.statusCode).toBe(422);
    expect(errorOf(wrong).code).toBe('CODE_INVALID');

    // The code was issued while the id was free; the action finds it taken under its own read.
    const otp = await kit.code(owner, confirmation);
    t.trackAdmin(
      await t.db().adminUser.create({
        data: { telegramId: BigInt(telegramId), name: 'Old', role: 'SUPPORT' },
      }),
    );
    const key = randomUUID();
    const taken = await kit.send('POST', owner, 'admins', { ...asked, reason: REASON, otp }, key);
    expect(taken.statusCode).toBe(400);
    expect(errorOf(taken).details).toEqual([{ path: 'telegramId', code: 'ADMIN_EXISTS' }]);
    // Now the confirmation itself refuses it: no code, no quota spent.
    const early = await kit.post(owner, 'confirmations', confirmation, null);
    expect(errorOf(early).details).toEqual([{ path: 'telegramId', code: 'ADMIN_EXISTS' }]);
    expect(await kit.alerts('adminAction', kit.auditIdOf(owner, key))).toBe(0);
  });

  it('deactivate: the admin is 404 at once, its sessions ended and its login codes EXPIRED, in one tx', async () => {
    const owner = await kit.session('OWNER');
    const op = await kit.session('OPERATOR');
    const nonce = await t.start();
    const issued = await t.issue(nonce, op.admin.telegramId);
    expect(issued.ok).toBe(true);
    const target = { action: 'admins.update', targetId: op.admin.id, isActive: false } as const;

    const res = await kit.withCode('PATCH', owner, `admins/${op.admin.id}`, target, {
      isActive: false,
    });
    expect(res.statusCode).toBe(200);
    const done = AdminAccountResponseSchema.parse(dataOf(res));
    expect(done.admin).toMatchObject({ isActive: false, activeSessions: 0 });
    expect(await kit.me(op.cookie)).toBe(404);
    const request = await t.db().loginRequest.findFirstOrThrow({ where: { nonce } });
    expect(request.status).toBe('EXPIRED');
    const audit = await t.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId ?? '' } });
    expect(audit).toMatchObject({ action: 'ADMIN_UPDATE', before: { isActive: true } });
    expect(audit.after).toMatchObject({
      isActive: false,
      expiredLoginCodes: 1,
      revokedSessions: 1,
      otpVerified: true,
    });
    expect(await kit.alerts('adminAction', audit.id)).toBe(1);
  });

  it('a role change ends the sessions; a rename keeps them; a no-op writes nothing', async () => {
    const owner = await kit.session('OWNER');
    const op = await kit.session('OPERATOR');
    const path = `admins/${op.admin.id}`;
    const renamed = await kit.withCode(
      'PATCH',
      owner,
      path,
      { action: 'admins.update', targetId: op.admin.id, name: 'Renamed' },
      { name: 'Renamed' },
    );
    expect(dataOf(renamed)).toMatchObject({ admin: { name: 'Renamed' }, applied: true });
    expect(await kit.me(op.cookie)).toBe(200);

    const same = await kit.withCode(
      'PATCH',
      owner,
      path,
      { action: 'admins.update', targetId: op.admin.id, name: 'Renamed' },
      { name: 'Renamed' },
    );
    expect(dataOf(same)).toMatchObject({ auditId: null, applied: false });

    const moved = await kit.withCode(
      'PATCH',
      owner,
      path,
      { action: 'admins.update', targetId: op.admin.id, role: 'SUPPORT' },
      { role: 'SUPPORT' },
    );
    expect(dataOf(moved)).toMatchObject({
      admin: { role: 'SUPPORT', activeSessions: 0 },
      applied: true,
    });
    expect(await kit.me(op.cookie)).toBe(404);
  });

  it('an OWNER row: no code (OWNER_ROW), and a code issued before it became OWNER is refused under the lock', async () => {
    const owner = await kit.session('OWNER');
    const other = await t.newAdmin('OWNER');
    const early = await kit.post(
      owner,
      'confirmations',
      { action: 'admins.update', targetId: other.id, isActive: false },
      null,
    );
    expect(errorOf(early).details).toEqual([{ path: 'id', code: 'OWNER_ROW' }]);

    const op = await t.newAdmin('OPERATOR');
    const confirmation = { action: 'admins.update', targetId: op.id, isActive: false } as const;
    const otp = await kit.code(owner, confirmation);
    await t.db().adminUser.update({ where: { id: op.id }, data: { role: 'OWNER' } });
    const key = randomUUID();
    const res = await kit.send(
      'PATCH',
      owner,
      `admins/${op.id}`,
      { isActive: false, reason: REASON, otp },
      key,
    );
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual([{ path: 'id', code: 'OWNER_ROW' }]);
    expect(await t.db().adminUser.findUniqueOrThrow({ where: { id: op.id } })).toMatchObject({
      isActive: true,
    });
    expect(await t.db().auditLog.count({ where: { id: kit.auditIdOf(owner, key) } })).toBe(0);
    expect(await kit.alerts('adminAction', kit.auditIdOf(owner, key))).toBe(0);
  });
});
