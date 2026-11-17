import { ADMIN_SESSION_IDLE_SEC, ADMIN_SESSION_TTL_SEC } from '@repo/shared';
import { ADMIN_BASE, setCookies } from './admin-e2e.api';
import { CLI_ACTOR, cliOf } from './admin-e2e.cli';
import { useAdminE2e } from './admin-e2e.harness';

const ME = `${ADMIN_BASE}/me`;
const PROBE = '/api/v1/admin/e2e-probe';

// Admin sessions end to end: absolute and idle life on a fake clock, the allowlist and the role
// read on every request, logout, and the owner CLI (admin:add, admin:deactivate) on the same app.
describe('admin sessions (real app)', () => {
  const t = useAdminE2e();
  const as = (cookie: string) => t.spa({ cookie });
  const me = (cookie: string) => t.request('GET', ME, as(cookie));

  it('dies 1 hour after its last use; lastUsedAt is written at most once a minute', async () => {
    const admin = await t.newAdmin('SUPPORT');
    const { cookie } = await t.login(admin);
    const lastUsed = async () =>
      (await t.db().adminSession.findFirstOrThrow({ where: { adminId: admin.id } })).lastUsedAt;
    const loginAt = await lastUsed();

    t.clock.advanceSec(30);
    expect((await me(cookie)).statusCode).toBe(200);
    expect(await lastUsed()).toEqual(loginAt); // under a minute: no write
    t.clock.advanceSec(31);
    expect((await me(cookie)).statusCode).toBe(200);
    expect((await lastUsed()).getTime()).toBe(t.clock.now().getTime());

    t.clock.advanceSec(ADMIN_SESSION_IDLE_SEC - 1);
    expect((await me(cookie)).statusCode).toBe(200); // used again in time: the hour restarts
    t.clock.advanceSec(ADMIN_SESSION_IDLE_SEC);
    expect((await me(cookie)).statusCode).toBe(404);
  });

  it('dies 8 hours after login however busy it is', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const { cookie } = await t.login(admin);
    const loginAt = t.clock.now().getTime();
    // Used every 50 minutes (under the idle hour) up to 7.5 hours after login.
    for (let i = 0; i < 9; i += 1) {
      t.clock.advanceSec(3_000);
      expect((await me(cookie)).statusCode).toBe(200);
    }
    t.clock.set(new Date(loginAt + ADMIN_SESSION_TTL_SEC * 1000 - 1000));
    const last = await me(cookie);
    expect(last.statusCode).toBe(200);
    expect(last.json<{ data: { session: { expiresAt: string } } }>().data.session.expiresAt).toBe(
      new Date(loginAt + ADMIN_SESSION_TTL_SEC * 1000).toISOString(),
    );
    t.clock.advanceSec(1);
    expect((await me(cookie)).statusCode).toBe(404);
  });

  it('taking the Telegram id off ADMIN_TELEGRAM_IDS ends access at the next request', async () => {
    const admin = await t.newAdmin('OWNER');
    const { cookie } = await t.login(admin);
    expect((await me(cookie)).statusCode).toBe(200);
    t.allowlist.splice(t.allowlist.indexOf(admin.telegramId), 1);
    expect((await me(cookie)).statusCode).toBe(404);
    t.allowlist.push(admin.telegramId);
    expect((await me(cookie)).statusCode).toBe(200); // the env decides; the session itself lives
  });

  it('a role change in the database takes effect on the next request', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const { cookie } = await t.login(admin);
    expect((await t.request('GET', `${PROBE}/staff`, as(cookie))).statusCode).toBe(200);
    await t.db().adminUser.update({ where: { id: admin.id }, data: { role: 'SUPPORT' } });
    expect((await t.request('GET', `${PROBE}/staff`, as(cookie))).statusCode).toBe(404);
    const body = (await me(cookie)).json<{ data: { admin: { role: string } } }>().data;
    expect(body.admin.role).toBe('SUPPORT');
    await t.db().adminUser.update({ where: { id: admin.id }, data: { isActive: false } });
    expect((await me(cookie)).statusCode).toBe(404);
  });

  it('a session route without a role list is refused for everyone, even OWNER (fail closed)', async () => {
    const admin = await t.newAdmin('OWNER');
    const { cookie } = await t.login(admin);
    expect((await t.request('GET', `${PROBE}/unmarked`, as(cookie))).statusCode).toBe(404);
  });

  it('logout ends the session, clears the cookie and is audited; the old cookie is dead', async () => {
    const admin = await t.newAdmin('SUPPORT');
    const { cookie } = await t.login(admin);
    const out = await t.request('POST', `${ADMIN_BASE}/logout`, as(cookie), undefined, {});
    expect(out.statusCode).toBe(200);
    expect(out.json<{ data: unknown }>().data).toEqual({});
    const cleared = setCookies(out).find((c) => c.startsWith(`${t.cookieName}=`)) ?? '';
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/SameSite=Strict/);
    expect((await me(cookie)).statusCode).toBe(404);
    const again = await t.request('POST', `${ADMIN_BASE}/logout`, as(cookie), undefined, {});
    expect(again.statusCode).toBe(404);
    const rows = await t
      .db()
      .auditLog.findMany({ where: { actorId: admin.id, action: 'ADMIN_LOGOUT' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'ADMIN', targetType: 'AdminSession' });
    const session = await t.db().adminSession.findFirstOrThrow({ where: { adminId: admin.id } });
    expect(session.revokedAt).not.toBeNull();
  });
});

describe('owner CLI: admin accounts (same app)', () => {
  const t = useAdminE2e();
  const run = cliOf(t);
  const ACTOR = CLI_ACTOR;

  it('admin:add creates an OWNER (only the CLI can), audited as CLI; that admin can sign in', async () => {
    const probe = await t.newAdmin('SUPPORT', { allowlisted: false });
    const telegramId = (probe.telegramId + 7n).toString();
    t.allowlist.push(BigInt(telegramId));
    const added = await run([
      'admin:add',
      '--telegram-id',
      telegramId,
      '--name',
      'Bosh ega',
      '--role',
      'OWNER',
      ...ACTOR,
    ]);
    expect(added.code).toBe(0);
    const admin = await t
      .db()
      .adminUser.findUniqueOrThrow({ where: { telegramId: BigInt(telegramId) } });
    t.trackAdmin(admin);
    expect(admin).toMatchObject({ role: 'OWNER', isActive: true, name: 'Bosh ega' });
    expect(added.out).toContain(`admin=${admin.id}`);
    const audit = await t
      .db()
      .auditLog.findFirstOrThrow({ where: { targetId: admin.id, action: 'ADMIN_CREATE' } });
    expect(audit).toMatchObject({
      actorType: 'CLI',
      actorId: null,
      ip: '203.0.113.9',
      reason: 'bootstrap of the e2e admin',
    });
    expect(audit.after).toMatchObject({ role: 'OWNER', operator: 'e2e-owner', allowlisted: true });

    const { cookie } = await t.login(admin);
    expect((await t.request('GET', ME, t.spa({ cookie }))).statusCode).toBe(200);

    const dup = await run([
      'admin:add',
      '--telegram-id',
      telegramId,
      '--name',
      'Twin',
      '--role',
      'SUPPORT',
      ...ACTOR,
    ]);
    expect(dup.code).toBe(1);
    expect(dup.err.join('\n')).toContain('ADMIN_EXISTS');
  });

  it('admin:add refuses a bad name, role or reason without writing', async () => {
    const id = '99' + String(Date.now()).slice(-9);
    for (const [flag, value] of [
      ['--name', '<b>x</b>'],
      ['--role', 'ROOT'],
      ['--name', 'ㅤ'],
    ] as const) {
      const argv = [
        'admin:add',
        '--telegram-id',
        id,
        '--name',
        'Ok',
        '--role',
        'SUPPORT',
        ...ACTOR,
      ];
      argv[argv.indexOf(flag) + 1] = value;
      expect((await run(argv)).code).toBe(1);
    }
    const short = await run([
      'admin:add',
      '--telegram-id',
      id,
      '--name',
      'Ok',
      '--role',
      'SUPPORT',
      '--reason',
      'short',
      '--operator',
      'x',
    ]);
    expect(short.code).toBe(1);
    expect(await t.db().adminUser.count({ where: { telegramId: BigInt(id) } })).toBe(0);
  });

  it('admin:deactivate ends every live session at once (next request 404) and is audited', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const first = await t.login(admin);
    const second = await t.login(admin);
    const listed = await run(['admin:list']);
    expect(listed.out.find((l) => l.startsWith(`admin=${admin.id} `))).toContain('sessions=2');

    const off = await run(['admin:deactivate', admin.id, ...ACTOR]);
    expect(off.code).toBe(0);
    expect(off.out).toEqual(expect.arrayContaining(['applied=true', 'revokedSessions=2']));
    for (const { cookie } of [first, second]) {
      expect((await t.request('GET', ME, t.spa({ cookie }))).statusCode).toBe(404);
    }
    const again = await run(['admin:deactivate', admin.id, ...ACTOR]);
    expect(again.out).toEqual(expect.arrayContaining(['applied=false', 'audit=-']));
    expect(again.code).toBe(0);
    expect(
      await t.db().auditLog.count({ where: { targetId: admin.id, action: 'ADMIN_UPDATE' } }),
    ).toBe(1);
  });

  it('admin:list counts only live sessions: an idle one (1 hour unused) is not counted (S2-n1)', async () => {
    const admin = await t.newAdmin('SUPPORT');
    await t.login(admin);
    await t.login(admin);
    const sessionsOf = async () =>
      (await run(['admin:list'])).out.find((l) => l.startsWith(`admin=${admin.id} `));
    expect(await sessionsOf()).toContain('sessions=2');
    t.clock.advanceSec(ADMIN_SESSION_IDLE_SEC - 1);
    expect(await sessionsOf()).toContain('sessions=2');
    t.clock.advanceSec(1);
    expect(await sessionsOf()).toContain('sessions=0');
    await t.login(admin);
    expect(await sessionsOf()).toContain('sessions=1');
  });
});
