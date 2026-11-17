import { createHash } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import {
  AdminLoginStartResponseSchema,
  AdminLoginVerifyResponseSchema,
  AdminMeResponseSchema,
  QUEUES,
  permissionsFor,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { OtpLoginService } from '../../auth/otp-login.service';
import { AdminLoginService } from '../auth/admin-login.service';
import { AdminSessionService } from '../auth/admin-session.service';
import { ADMIN_BASE, OWNER_CHATS, setCookies } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';

// The admin login end to end (docs/04 «Auth», D-27 pattern, D-63 (9)): real AppModule, real
// Postgres and Redis, the bot side through AdminLoginService.issueCode (what the bot handler
// calls). Nothing reaches Telegram: the outbox worker is off in tests, jobs are inspected.
describe('admin login (real app)', () => {
  const t = useAdminE2e();
  const statusOf = async (nonce: string): Promise<string> => {
    const res = await t.request('GET', `${ADMIN_BASE}/status/${nonce}`, t.spa());
    return res.json<{ data: { status: string } }>().data.status;
  };
  const errorOf = (res: Awaited<ReturnType<typeof t.verify>>) =>
    res.json<{ error: { code: string; details?: { attemptsLeft?: number } } }>().error;
  const secrets: string[] = [];

  it('start -> bot code -> verify: session cookie, hashed token, me, audit, notices', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const ip = t.nextIp();
    const started = await t.request('POST', `${ADMIN_BASE}/start`, t.spa(), ip, {});
    expect(started.statusCode).toBe(200);
    const { nonce, botUrl } = AdminLoginStartResponseSchema.parse(
      started.json<{ data: unknown }>().data,
    );
    t.trackNonce(nonce);
    expect(botUrl).toBe(`https://t.me/${t.env.TELEGRAM_BOT_USERNAME}?start=admin_${nonce}`);
    expect(await statusOf(nonce)).toBe('PENDING');

    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(issued.reason);
    // SA-L4: the bot shows where the login was started, masked.
    expect(issued.origin).toEqual({ ip: ip.replace(/\.\d+$/, '.x'), device: null });
    expect(await statusOf(nonce)).toBe('CODE_SENT');

    const verified = await t.verify(nonce, issued.code, ip);
    expect(verified.statusCode).toBe(200);
    const self = AdminLoginVerifyResponseSchema.parse(verified.json<{ data: unknown }>().data);
    expect(self.admin).toMatchObject({ id: admin.id, name: admin.name, role: 'OPERATOR' });
    expect(self.admin.telegramIdMasked).toMatch(/^\d{2}\*+\d{2}$/);
    const line = setCookies(verified).find((c) => c.startsWith(`${t.cookieName}=`)) ?? '';
    const token = line.slice(t.cookieName.length + 1).split(';')[0] ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    secrets.push(nonce, issued.code, token);

    const [session] = await t.db().adminSession.findMany({ where: { adminId: admin.id } });
    expect(session?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(session?.ip).toBe(ip.replace(/\.\d+$/, '.x'));
    expect(await statusOf(nonce)).toBe('EXPIRED'); // USED reads as EXPIRED

    const me = await t.request(
      'GET',
      `${ADMIN_BASE}/me`,
      t.spa({ cookie: `${t.cookieName}=${token}` }),
    );
    expect(me.statusCode).toBe(200);
    const body = AdminMeResponseSchema.parse(me.json<{ data: unknown }>().data);
    expect(body.permissions).toEqual(permissionsFor('OPERATOR'));
    expect(body.limits).toEqual({
      operatorRefundMaxTiyin: t.env.ADMIN_OPERATOR_REFUND_MAX_TIYIN.toString(),
      confirmThresholdTiyin: t.env.ADMIN_CONFIRM_THRESHOLD_TIYIN.toString(),
    });
    expect(me.headers['cache-control']).toBe('no-store');

    const audit = await t
      .db()
      .auditLog.findMany({ where: { actorId: admin.id, action: 'ADMIN_LOGIN' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'ADMIN',
      targetType: 'AdminSession',
      targetId: session?.id,
      ip,
    });

    const queue = t.app().get<Queue<Record<string, unknown>>>(getQueueToken(QUEUES.TG_OUTBOX));
    const own = await queue.getJob(`adminlogin-${session?.id ?? ''}`);
    expect(own?.data).toMatchObject({ chatId: admin.telegramId.toString() });
    expect(JSON.stringify(own?.data)).toContain(`ae:${session?.id ?? ''}`);
    for (const chat of OWNER_CHATS) {
      const alert = await queue.getJob(`alert-adminLogin-${session?.id ?? ''}-${chat}`);
      expect(alert?.data).toMatchObject({ chatId: chat });
      expect(JSON.stringify(alert?.data)).toContain(admin.name);
    }
    for (const job of [own, ...(await queue.getJobs(['waiting', 'delayed']))]) {
      const text = JSON.stringify(job?.data ?? {});
      for (const secret of [nonce, issued.code, token]) expect(text).not.toContain(secret);
    }
  });

  it.each([
    ['an account that is not an admin', { allowlisted: false, active: true }, false],
    ['an admin not in ADMIN_TELEGRAM_IDS', { allowlisted: false, active: true }, true],
    ['an inactive admin', { allowlisted: true, active: false }, true],
  ])('%s gets no code and the request stays PENDING (no oracle)', async (_n, opts, hasRow) => {
    const admin = await t.newAdmin('OWNER', opts);
    const telegramId = hasRow ? admin.telegramId : admin.telegramId + 1n;
    const nonce = await t.start();
    expect(await t.issue(nonce, telegramId)).toEqual({ ok: false, reason: 'expired' });
    expect(await statusOf(nonce)).toBe('PENDING');
    const row = await t.db().loginRequest.findUnique({ where: { nonce } });
    expect(row).toMatchObject({
      kind: 'ADMIN',
      status: 'PENDING',
      telegramId: null,
      codeHash: null,
    });
  });

  it('5 wrong codes lock the request; the right code after that is CODE_EXPIRED', async () => {
    const admin = await t.newAdmin('SUPPORT');
    const nonce = await t.start();
    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(issued.reason);
    const wrong = String((Number(issued.code) + 1) % 1_000_000).padStart(6, '0');
    for (let left = 4; left >= 0; left -= 1) {
      const res = await t.verify(nonce, wrong);
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({ code: 'CODE_INVALID', details: { attemptsLeft: left } });
    }
    const late = await t.verify(nonce, issued.code);
    expect(errorOf(late).code).toBe('CODE_EXPIRED');
    expect(await statusOf(nonce)).toBe('EXPIRED');
  });

  it('a code is good for 3 minutes and for one use', async () => {
    const admin = await t.newAdmin('SUPPORT');
    const old = await t.start();
    const stale = await t.issue(old, admin.telegramId);
    if (!stale.ok) throw new Error(stale.reason);
    t.clock.advanceSec(181);
    expect(errorOf(await t.verify(old, stale.code)).code).toBe('CODE_EXPIRED');

    const nonce = await t.start();
    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(issued.reason);
    expect((await t.verify(nonce, issued.code)).statusCode).toBe(200);
    expect(errorOf(await t.verify(nonce, issued.code)).code).toBe('CODE_EXPIRED');
  });

  it('two parallel verifies with one code open exactly one session', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const nonce = await t.start();
    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(issued.reason);
    const results = await Promise.all([t.verify(nonce, issued.code), t.verify(nonce, issued.code)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    expect(await t.db().adminSession.count({ where: { adminId: admin.id } })).toBe(1);
    expect(
      await t.db().auditLog.count({ where: { actorId: admin.id, action: 'ADMIN_LOGIN' } }),
    ).toBe(1);
  });

  it('an admin deactivated or taken off the allowlist after the code was sent cannot use it', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const nonce = await t.start();
    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(issued.reason);
    await t.db().adminUser.update({ where: { id: admin.id }, data: { isActive: false } });
    expect(errorOf(await t.verify(nonce, issued.code)).code).toBe('CODE_EXPIRED');

    const other = await t.newAdmin('OPERATOR');
    const second = await t.start();
    const code = await t.issue(second, other.telegramId);
    if (!code.ok) throw new Error(code.reason);
    t.allowlist.splice(t.allowlist.indexOf(other.telegramId), 1);
    expect(errorOf(await t.verify(second, code.code)).code).toBe('CODE_EXPIRED');
    expect(
      await t.db().adminSession.count({ where: { adminId: { in: [admin.id, other.id] } } }),
    ).toBe(0);
  });

  it('«Bu men emasman» kills an unused code; after login it ends the session (both audited)', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const login = t.app().get(AdminLoginService);
    const nonce = await t.start();
    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(issued.reason);
    const deny = (n: string, telegramId: bigint) =>
      login.deny({ nonce: n, telegramId, now: t.clock.now() });
    expect(await deny(nonce, admin.telegramId + 1n)).toBe('expired'); // someone else's button
    expect(await deny(nonce, admin.telegramId)).toBe('denied');
    expect(await statusOf(nonce)).toBe('DENIED');
    expect(errorOf(await t.verify(nonce, issued.code)).code).toBe('CODE_EXPIRED');

    // The code message's button pressed after the login went through: the session ends.
    const used = await t.start();
    const code = await t.issue(used, admin.telegramId);
    if (!code.ok) throw new Error(code.reason);
    const verified = await t.verify(used, code.code);
    const cookie = setCookies(verified)[0]?.split(';')[0] ?? '';
    expect(await deny(used, admin.telegramId)).toBe('sessionEnded');
    expect((await t.request('GET', `${ADMIN_BASE}/me`, t.spa({ cookie }))).statusCode).toBe(404);

    // The "new login" message's button (ae:<sessionId>): only the session's own admin may end it.
    const second = await t.login(admin);
    const session = await t.db().adminSession.findFirstOrThrow({
      where: { adminId: admin.id, revokedAt: null },
    });
    const sessions = t.app().get(AdminSessionService);
    expect(await sessions.endFromBot(session.id, admin.telegramId + 1n, t.clock.now())).toBe(
      'alreadyEnded',
    );
    const me = () => t.request('GET', `${ADMIN_BASE}/me`, t.spa({ cookie: second.cookie }));
    expect((await me()).statusCode).toBe(200);
    expect(await sessions.endFromBot(session.id, admin.telegramId, t.clock.now())).toBe('ended');
    expect((await me()).statusCode).toBe(404);
    expect(await sessions.endFromBot(session.id, admin.telegramId, t.clock.now())).toBe(
      'alreadyEnded',
    );
    const revokes = await t.db().auditLog.findMany({
      where: { actorId: admin.id, action: 'ADMIN_SESSION_REVOKE' },
    });
    expect(revokes.map((r) => (r.after as { source?: string }).source).sort()).toEqual([
      'bot',
      'botDeny',
    ]);
  });

  it('a malformed or unknown nonce is a 404 on status; a user login nonce is not an admin one', async () => {
    expect((await t.request('GET', `${ADMIN_BASE}/status/short`, t.spa())).statusCode).toBe(404);
    const userNonce = (await t.app().get(OtpLoginService).start(t.clock.now())).nonce;
    t.trackNonce(userNonce);
    expect((await t.request('GET', `${ADMIN_BASE}/status/${userNonce}`, t.spa())).statusCode).toBe(
      404,
    );
    expect(
      (await t.request('GET', `/api/v1/auth/telegram/status/${await t.start()}`)).statusCode,
    ).toBe(404);
    expect(
      (await t.request('GET', `${ADMIN_BASE}/status/${'z'.repeat(43)}`, t.spa())).statusCode,
    ).toBe(404);
  });

  it('no code, nonce, token or full client address in the log output', async () => {
    const admin = await t.newAdmin('OWNER');
    const ip = t.nextIp();
    const nonce = await t.start(ip);
    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(issued.reason);
    await t.request('GET', `${ADMIN_BASE}/status/${nonce}`, t.spa(), ip);
    const wrong = String((Number(issued.code) + 1) % 1_000_000).padStart(6, '0');
    await t.verify(nonce, wrong, ip);
    const ok = await t.verify(nonce, issued.code, ip);
    const token = (setCookies(ok)[0] ?? '').slice(t.cookieName.length + 1).split(';')[0] ?? '';
    await t.request(
      'POST',
      `${ADMIN_BASE}/logout`,
      t.spa({ cookie: `${t.cookieName}=${token}` }),
      ip,
      {},
    );
    for (let i = 0; i < 50 && !t.logs.text().includes('request completed'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const output = t.logs.text();
    expect(output).toContain('request completed');
    expect(output).toContain('ADMIN_LOGIN');
    for (const secret of [...secrets, nonce, issued.code, wrong, token]) {
      expect(output).not.toContain(secret);
    }
    // The client address: only in the access log's own `ip` field (every route, phase 1 policy);
    // no admin log line carries it.
    const own = t.logs.records().filter((r) => r['msg'] !== 'request completed');
    expect(own.length).toBeGreaterThan(0);
    expect(JSON.stringify(own)).not.toContain(ip);
  });
});
