import { randomUUID } from 'node:crypto';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import { REASON, adminAccountsKit } from './admin-accounts-write.e2e-kit';
import { CLI_ACTOR, cliOf, type CliRun } from './admin-e2e.cli';
import { useAdminE2e } from './admin-e2e.harness';
import { heldTransaction, waitForLockWaiter } from './admin-e2e.locks';
import { dataOf, errorOf } from './admin-write.e2e-kit';

// Phase 9 S9a: the panel's admin management under real row locks, with the interleaving chosen by
// the test (admin-races.e2e-spec.ts's pattern). Lock order: acting admin FOR SHARE -> target
// (FOR UPDATE for a change, FOR SHARE for a revoke) -> sessions; never lockActiveOwners. No
// interleaving may end in a deadlock (40P01), which would surface as a 500.
const t = useAdminE2e();
const kit = adminAccountsKit(t);
const run = cliOf(t);
const repo = () => t.app().get(AdminUsersRepository);

const noDeadlockLogged = () => expect(t.logs.text()).not.toMatch(/40P01|deadlock/i);

describe('admin management races (real app, real row locks)', () => {
  it('two OWNERs add the same Telegram id at once: one admin, the other ADMIN_EXISTS, no 500', async () => {
    const [a, b] = [await kit.session('OWNER'), await kit.session('OWNER')];
    const telegramId = kit.freshTelegramId();
    const asked = { telegramId, name: 'Twin', role: 'OPERATOR' } as const;
    const confirmation = { action: 'admins.create', ...asked } as const;
    const [otpA, otpB] = [await kit.code(a, confirmation), await kit.code(b, confirmation)];
    // CR-3: both transactions read "no such admin" before either inserts, so the unique index
    // (not the read) decides: the loser's P2002 must come back as ADMIN_EXISTS, never a 500.
    const users = repo();
    const original = users.findByTelegramId.bind(users);
    let arrived = 0;
    let release = (): void => undefined;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    users.findByTelegramId = async (id, db) => {
      const found = await original(id, db);
      arrived += 1;
      if (arrived >= 2) release();
      await Promise.race([bothRead, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      return found;
    };
    const [ra, rb] = await Promise.all([
      kit.send('POST', a, 'admins', { ...asked, reason: REASON, otp: otpA }),
      kit.send('POST', b, 'admins', { ...asked, reason: REASON, otp: otpB }),
    ]).finally(() => {
      users.findByTelegramId = original;
    });
    expect(arrived).toBe(2);
    await kit.track(telegramId);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([200, 400]);
    const loser = ra.statusCode === 400 ? ra : rb;
    expect(errorOf(loser).details).toEqual([{ path: 'telegramId', code: 'ADMIN_EXISTS' }]);
    expect(await t.db().adminUser.count({ where: { telegramId: BigInt(telegramId) } })).toBe(1);
  });

  it('the CLI deactivates the acting OWNER first: the panel waits on its FOR SHARE, then 404, nothing written', async () => {
    const owner = await kit.session('OWNER');
    const op = await t.newAdmin('OPERATOR');
    const otp = await kit.code(owner, {
      action: 'admins.update',
      targetId: op.id,
      role: 'SUPPORT',
    });
    // What admin:deactivate of the acting OWNER does, held open: every OWNER row locked, it off.
    const holder = await heldTransaction(t.db(), async (tx) => {
      await repo().lockActiveOwners(tx);
      await repo().deactivate(tx, owner.admin.id);
    });
    const key = randomUUID();
    let settled = false;
    const patching = kit
      .send('PATCH', owner, `admins/${op.id}`, { role: 'SUPPORT', reason: REASON, otp }, key)
      .finally(() => {
        settled = true;
      });
    const waited = await waitForLockWaiter(t.db(), '%"AdminUser"%FOR SHARE%', () => settled);
    await holder.commit();
    const res = await patching;

    expect(waited).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(await t.db().adminUser.findUniqueOrThrow({ where: { id: op.id } })).toMatchObject({
      role: 'OPERATOR',
    });
    expect(await t.db().auditLog.count({ where: { id: kit.auditIdOf(owner, key) } })).toBe(0);
  });

  it('the panel holds its locks while the CLI deactivates the acting OWNER: the CLI waits, both finish, no deadlock', async () => {
    const owner = await kit.session('OWNER');
    const op = await t.newAdmin('OPERATOR');
    const otp = await kit.code(owner, {
      action: 'admins.update',
      targetId: op.id,
      isActive: false,
    });
    // Real production code, only the timing is chosen: once the panel holds the acting OWNER's
    // FOR SHARE and the target's FOR UPDATE, admin:deactivate of that OWNER starts and runs until
    // Postgres reports it blocked (its lock on every OWNER row); only then does the panel go on.
    const users = repo();
    const original = users.lockById.bind(users);
    const started: { cli?: Promise<CliRun> } = {};
    let waited = false;
    users.lockById = async (tx, id, mode) => {
      users.lockById = original;
      const locked = await original(tx, id, mode);
      let settled = false;
      started.cli = run([
        'admin:deactivate',
        owner.admin.id,
        '--confirm-last-owner',
        ...CLI_ACTOR,
      ]).finally(() => {
        settled = true;
      });
      waited = await waitForLockWaiter(t.db(), '%"AdminUser"%FOR UPDATE%', () => settled);
      return locked;
    };
    const res = await kit.send('PATCH', owner, `admins/${op.id}`, {
      isActive: false,
      reason: REASON,
      otp,
    });
    users.lockById = original;
    if (started.cli === undefined) throw new Error('the CLI never started');
    const cli = await started.cli;

    expect(waited).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)).toMatchObject({ admin: { isActive: false }, applied: true });
    expect(cli.code).toBe(0);
    expect(cli.out).toEqual(expect.arrayContaining(['applied=true']));
    expect(
      await t.db().adminUser.findUniqueOrThrow({ where: { id: owner.admin.id } }),
    ).toMatchObject({ isActive: false });
    noDeadlockLogged();
  });

  it('two OWNERs end each other’s sessions at the same moment: both 200, no deadlock', async () => {
    const [a, b] = [await kit.session('OWNER'), await kit.session('OWNER')];
    const otpA = await kit.code(a, { action: 'admins.sessionsRevoke', targetId: b.admin.id });
    const otpB = await kit.code(b, { action: 'admins.sessionsRevoke', targetId: a.admin.id });
    // Both pass their actor lock before either takes its target lock: the crossed order a
    // FOR UPDATE on the target would turn into a deadlock.
    const users = repo();
    const original = users.lockById.bind(users);
    let arrived = 0;
    let release = (): void => undefined;
    const bothIn = new Promise<void>((resolve) => {
      release = resolve;
    });
    users.lockById = async (tx, id, mode) => {
      arrived += 1;
      if (arrived >= 2) release();
      await Promise.race([bothIn, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      return original(tx, id, mode);
    };
    const [ra, rb] = await Promise.all([
      kit.send('POST', a, `admins/${b.admin.id}/sessions/revoke`, { reason: REASON, otp: otpA }),
      kit.send('POST', b, `admins/${a.admin.id}/sessions/revoke`, { reason: REASON, otp: otpB }),
    ]);
    users.lockById = original;

    expect(arrived).toBe(2);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    noDeadlockLogged();
  });
});
