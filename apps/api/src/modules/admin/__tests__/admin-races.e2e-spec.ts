import type { AdminRole, AdminUser } from '@repo/db';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import { ADMIN_BASE, setCookies } from './admin-e2e.api';
import { CLI_ACTOR, cliOf } from './admin-e2e.cli';
import { useAdminE2e } from './admin-e2e.harness';
import { heldTransaction, waitForLockWaiter } from './admin-e2e.locks';

const ME = `${ADMIN_BASE}/me`;

// The row locks of the admin lifecycle, with the interleaving chosen by the test rather than left
// to timing (S2R-2, CR 3): a holder transaction takes the lock, the test waits until Postgres
// reports the other side blocked on it, and only then lets the holder commit.
describe('admin lifecycle races (real app, real row locks)', () => {
  const t = useAdminE2e();
  const run = cliOf(t);
  const mine: string[] = [];
  const admin = async (role: AdminRole): Promise<AdminUser> => {
    const created = await t.newAdmin(role);
    mine.push(created.id);
    return created;
  };
  const repo = () => t.app().get(AdminUsersRepository);
  const issued = async (target: AdminUser) => {
    const nonce = await t.start();
    const code = await t.issue(nonce, target.telegramId);
    if (!code.ok) throw new Error(`issueCode refused: ${code.reason}`);
    return { nonce, code: code.code };
  };

  beforeEach(async () => {
    await t.db().adminUser.updateMany({ where: { id: { in: mine } }, data: { isActive: false } });
  });

  it('verify waits for a deactivation holding the admin row, then refuses it (FOR SHARE)', async () => {
    const op = await admin('OPERATOR');
    const { nonce, code } = await issued(op);
    const holder = await heldTransaction(t.db(), (tx) => repo().deactivate(tx, op.id));

    let settled = false;
    const verifying = t.verify(nonce, code).finally(() => {
      settled = true;
    });
    const waited = await waitForLockWaiter(t.db(), '%"AdminUser"%FOR SHARE%', () => settled);
    await holder.commit();
    const res = await verifying;

    expect(waited).toBe(true);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CODE_EXPIRED');
    expect(await t.db().adminSession.count({ where: { adminId: op.id } })).toBe(0);
  });

  it('a deactivation committed between verify’s first read and its session: refused, nothing to revive', async () => {
    const op = await admin('OPERATOR');
    const { nonce, code } = await issued(op);
    // Real production code, only the timing is chosen: admin:deactivate commits right after
    // verify's unlocked early read (the reviewer's probe).
    const users = repo();
    const original = users.findByTelegramId.bind(users);
    let deactivated = -1;
    users.findByTelegramId = async (id, db) => {
      const found = await original(id, db);
      users.findByTelegramId = original;
      deactivated = (await run(['admin:deactivate', op.id, ...CLI_ACTOR])).code;
      return found;
    };
    const res = await t.verify(nonce, code);
    users.findByTelegramId = original;
    expect(deactivated).toBe(0);
    expect(res.statusCode).toBe(422);
    expect(setCookies(res)).toEqual([]);
    expect(await t.db().adminSession.count({ where: { adminId: op.id } })).toBe(0);

    const back = await run(['admin:reactivate', op.id, ...CLI_ACTOR]);
    expect(back.out).toEqual(expect.arrayContaining(['applied=true', 'revokedSessions=0']));
    expect(await t.db().adminSession.count({ where: { adminId: op.id } })).toBe(0);
    // A fresh login is the only way back in.
    const { cookie } = await t.login(op);
    expect((await t.request('GET', ME, t.spa({ cookie }))).statusCode).toBe(200);
  });

  it('a deactivation waits for another holding the OWNER lock; then exactly one OWNER is left (FOR UPDATE)', async () => {
    const [a, b] = [await admin('OWNER'), await admin('OWNER')];
    // What admin:deactivate of `a` does, held open: the OWNER rows locked, `a` switched off.
    const holder = await heldTransaction(t.db(), async (tx) => {
      await repo().lockActiveOwners(tx);
      await repo().deactivate(tx, a.id);
    });

    let settled = false;
    const second = run(['admin:deactivate', b.id, ...CLI_ACTOR]).finally(() => {
      settled = true;
    });
    const waited = await waitForLockWaiter(t.db(), '%"AdminUser"%FOR UPDATE%', () => settled);
    await holder.commit();
    const result = await second;

    expect(waited).toBe(true);
    expect(result.code).toBe(2); // after the wait `b` is the last one: refused without the flag
    const left = await t.db().adminUser.findMany({
      where: { id: { in: [a.id, b.id] }, isActive: true },
    });
    expect(left.map((r) => r.id)).toEqual([b.id]);
  });
});
