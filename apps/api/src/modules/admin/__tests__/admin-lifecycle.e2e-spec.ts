import type { AdminRole, AdminUser } from '@repo/db';
import { ADMIN_BASE, setCookies } from './admin-e2e.api';
import { CLI_ACTOR, cliOf } from './admin-e2e.cli';
import { useAdminE2e } from './admin-e2e.harness';

const ME = `${ADMIN_BASE}/me`;

// admin:deactivate / admin:reactivate / admin:set-role end to end, on the app that serves the
// panel (S2 fix rounds: S2-m2/S2-3, S2R-2/3/5). The "last OWNER" rule counts OWNERs that are
// active AND in ADMIN_TELEGRAM_IDS; this app's allowlist holds only the admins this file makes,
// so rows of other suites never change its answer. Each test first retires this file's admins.
describe('owner CLI: the last usable OWNER, reactivate and set-role (same app)', () => {
  const t = useAdminE2e();
  const run = cliOf(t);
  const mine: string[] = [];
  const admin = async (role: AdminRole, allowlisted = true): Promise<AdminUser> => {
    const created = await t.newAdmin(role, { allowlisted });
    mine.push(created.id);
    return created;
  };
  const row = (id: string) => t.db().adminUser.findUniqueOrThrow({ where: { id } });
  const audits = (id: string) =>
    t.db().auditLog.findMany({ where: { targetId: id, action: 'ADMIN_UPDATE' } });
  const me = (cookie: string) => t.request('GET', ME, t.spa({ cookie }));
  const usage = (id: string) =>
    `usage error: admin ${id} is the last active, allowlisted OWNER: this leaves no OWNER who ` +
    'can sign in. Re-run with --confirm-last-owner only if that is really intended';

  beforeEach(async () => {
    await t.db().adminUser.updateMany({ where: { id: { in: mine } }, data: { isActive: false } });
  });

  it('deactivate: the last usable OWNER needs --confirm-last-owner (exit 2 without it)', async () => {
    const [x, y] = [await admin('OWNER'), await admin('OWNER')];
    const support = await admin('SUPPORT');
    expect((await run(['admin:deactivate', x.id, ...CLI_ACTOR])).code).toBe(0); // y is left

    const refused = await run(['admin:deactivate', y.id, ...CLI_ACTOR]);
    expect(refused.code).toBe(2);
    expect(refused.err[0]).toBe(usage(y.id));
    expect((await row(y.id)).isActive).toBe(true);
    expect(await audits(y.id)).toHaveLength(0);

    const done = await run(['admin:deactivate', y.id, '--confirm-last-owner', ...CLI_ACTOR]);
    expect(done.code).toBe(0);
    expect(done.out).toEqual(expect.arrayContaining(['applied=true', `admin=${y.id}`]));
    expect(done.err).toEqual([
      'WARNING: no active, allowlisted OWNER is left: owner-only actions are impossible in the panel.',
      'WARNING: only 1 non-owner admin(s) can still sign in.',
      `restore: admin:reactivate ${y.id} --reason <text> --operator <name>`,
    ]);
    expect((await row(y.id)).isActive).toBe(false);
    expect((await audits(y.id))[0]?.after).toMatchObject({
      isActive: false,
      expiredLoginCodes: 0,
      lastOwnerConfirmed: true,
    });
    expect((await row(support.id)).isActive).toBe(true); // others untouched
  });

  it('an OWNER off the allowlist does not count: the allowlisted one is still the last (S2R-5)', async () => {
    const usable = await admin('OWNER');
    const offList = await admin('OWNER', false);
    const refused = await run(['admin:deactivate', usable.id, ...CLI_ACTOR]);
    expect(refused.code).toBe(2);
    expect(refused.err[0]).toBe(usage(usable.id));
    // The other way round nothing usable is lost: no confirmation needed.
    expect((await run(['admin:deactivate', offList.id, ...CLI_ACTOR])).code).toBe(0);
    const done = await run(['admin:deactivate', usable.id, '--confirm-last-owner', ...CLI_ACTOR]);
    expect(done.err[1]).toBe(
      'WARNING: no active, allowlisted admin is left at all: nobody can sign in to the admin panel.',
    );
  });

  it('two parallel deactivations of the last two OWNERs: exactly one goes through', async () => {
    const [a, b] = [await admin('OWNER'), await admin('OWNER')];
    const results = await Promise.all([
      run(['admin:deactivate', a.id, ...CLI_ACTOR]),
      run(['admin:deactivate', b.id, ...CLI_ACTOR]),
    ]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 2]);
    const left = await t
      .db()
      .adminUser.count({ where: { id: { in: [a.id, b.id] }, isActive: true } });
    expect(left).toBe(1);
  });

  it('reactivate: active again, every old session ended, a new login works; a replay changes nothing', async () => {
    const op = await admin('OPERATOR');
    const before = await t.login(op);
    expect((await run(['admin:deactivate', op.id, ...CLI_ACTOR])).code).toBe(0);

    const back = await run(['admin:reactivate', op.id, ...CLI_ACTOR]);
    expect(back.code).toBe(0);
    expect(back.out).toEqual(expect.arrayContaining(['applied=true', 'revokedSessions=0']));
    expect((await row(op.id)).isActive).toBe(true);
    expect((await me(before.cookie)).statusCode).toBe(404);
    expect((await me((await t.login(op)).cookie)).statusCode).toBe(200);
    // AuditLog ids are random (cuid2): pick the reactivation by its content, not by order.
    const audit = (await audits(op.id)).find(
      (a) => JSON.stringify(a.before) === '{"isActive":false}',
    );
    expect(audit).toMatchObject({ reason: 'bootstrap of the e2e admin' });
    expect(audit?.after).toMatchObject({
      isActive: true,
      allowlisted: true,
      revokedSessions: 0,
      operator: 'e2e-owner',
    });

    const replay = await run(['admin:reactivate', op.id, ...CLI_ACTOR]);
    expect(replay.out).toEqual(expect.arrayContaining(['applied=false', 'audit=-']));
    expect(await audits(op.id)).toHaveLength(2);
  });

  it('reactivate ends a session that outlived the deactivation, so it never comes back (S2R-2 a)', async () => {
    const op = await admin('OPERATOR');
    const { cookie } = await t.login(op);
    // Deactivated without its sessions ended (as a session opened across a deactivation is).
    await t.db().adminUser.update({ where: { id: op.id }, data: { isActive: false } });
    expect((await me(cookie)).statusCode).toBe(404);

    const back = await run(['admin:reactivate', op.id, ...CLI_ACTOR]);
    expect(back.out).toEqual(expect.arrayContaining(['applied=true', 'revokedSessions=1']));
    expect((await me(cookie)).statusCode).toBe(404);
    const [audit] = await audits(op.id);
    expect(audit?.after).toMatchObject({ isActive: true, revokedSessions: 1 });
  });

  it('deactivate expires the open admin codes: after a quick reactivate the old code is dead (CR nit 2)', async () => {
    const op = await admin('OPERATOR');
    const nonce = await t.start();
    const sent = await t.issue(nonce, op.telegramId);
    if (!sent.ok) throw new Error(`issueCode refused: ${sent.reason}`);
    // The same person's web-store login code: another kind, it must survive.
    const webCode = await t.db().loginRequest.create({
      data: {
        nonce: `e2e-web-${op.id}`,
        kind: 'USER',
        status: 'CODE_SENT',
        telegramId: op.telegramId,
        codeHash: 'e2e-web-code-hash',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect((await run(['admin:deactivate', op.id, ...CLI_ACTOR])).code).toBe(0);
    expect((await run(['admin:reactivate', op.id, ...CLI_ACTOR])).code).toBe(0);
    const res = await t.verify(nonce, sent.code);

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CODE_EXPIRED');
    expect(setCookies(res)).toEqual([]);
    expect(await t.db().adminSession.count({ where: { adminId: op.id } })).toBe(0);
    const statusOf = async (where: { nonce: string } | { id: string }) =>
      (await t.db().loginRequest.findUniqueOrThrow({ where })).status;
    expect(await statusOf({ nonce })).toBe('EXPIRED');
    expect(await statusOf({ id: webCode.id })).toBe('CODE_SENT');
    const off = (await audits(op.id)).find((a) => JSON.stringify(a.before) === '{"isActive":true}');
    expect(off?.after).toMatchObject({ isActive: false, expiredLoginCodes: 1 });
  });

  it('set-role: OWNER only here; ANY change, up or down, ends the sessions (S2R-3)', async () => {
    const owner = await admin('OWNER');
    const op = await admin('OPERATOR');
    const opSession = await t.login(op);
    const up = await run(['admin:set-role', op.id, '--role', 'OWNER', ...CLI_ACTOR]);
    expect(up.code).toBe(0);
    expect(up.out).toEqual(expect.arrayContaining(['applied=true', 'revokedSessions=1']));
    expect((await me(opSession.cookie)).statusCode).toBe(404); // a new role: a new login
    const asOwner = await me((await t.login(op)).cookie);
    expect(asOwner.json<{ data: { admin: { role: string } } }>().data.admin.role).toBe('OWNER');
    const [upAudit] = await audits(op.id);
    expect(upAudit).toMatchObject({ before: { role: 'OPERATOR' } });
    expect(upAudit?.after).toMatchObject({ role: 'OWNER', revokedSessions: 1 });

    const ownerSession = await t.login(owner);
    const down = await run(['admin:set-role', owner.id, '--role', 'SUPPORT', ...CLI_ACTOR]);
    expect(down.code).toBe(0); // op is an OWNER now: not the last one
    expect(down.out).toEqual(expect.arrayContaining(['applied=true', 'revokedSessions=1']));
    expect((await me(ownerSession.cookie)).statusCode).toBe(404);
    expect((await row(owner.id)).role).toBe('SUPPORT');
    const [audit] = await audits(owner.id);
    expect(audit).toMatchObject({ before: { role: 'OWNER' } });
    expect(audit?.after).toMatchObject({ role: 'SUPPORT', revokedSessions: 1 });

    const same = await run(['admin:set-role', owner.id, '--role', 'SUPPORT', ...CLI_ACTOR]);
    expect(same.out).toEqual(expect.arrayContaining(['applied=false', 'audit=-']));
    const bad = await run(['admin:set-role', owner.id, '--role', 'ROOT', ...CLI_ACTOR]);
    expect(bad.code).toBe(1);
  });

  it('set-role: moving the last usable OWNER down needs --confirm-last-owner', async () => {
    const last = await admin('OWNER');
    const refused = await run(['admin:set-role', last.id, '--role', 'OPERATOR', ...CLI_ACTOR]);
    expect(refused.code).toBe(2);
    expect((await row(last.id)).role).toBe('OWNER');
    const done = await run([
      'admin:set-role',
      last.id,
      '--role',
      'OPERATOR',
      '--confirm-last-owner',
      ...CLI_ACTOR,
    ]);
    expect(done.code).toBe(0);
    expect(done.err.at(-1)).toBe(
      `restore: admin:set-role ${last.id} --role OWNER --reason <text> --operator <name>`,
    );
    expect((await row(last.id)).role).toBe('OPERATOR');
  });

  it('an unknown admin id is NOT_FOUND (exit 1); a malformed one is a validation error', async () => {
    for (const command of ['admin:deactivate', 'admin:reactivate']) {
      const unknown = await run([command, 'cmnoadmin000000000000000', ...CLI_ACTOR]);
      expect([command, unknown.code, unknown.err[0]]).toEqual([command, 1, 'refused: NOT_FOUND']);
      expect((await run([command, 'x;drop', ...CLI_ACTOR])).code).toBe(1);
    }
  });
});
