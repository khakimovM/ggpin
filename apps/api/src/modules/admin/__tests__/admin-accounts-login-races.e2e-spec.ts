import type { AdminUser } from '@repo/db';
import type { AdminConfirmationBody } from '@repo/shared';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import { AdminSessionService } from '../auth/admin-session.service';
import { REASON, adminAccountsKit } from './admin-accounts-write.e2e-kit';
import { setCookies, type Res } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';
import { waitForLockWaiter } from './admin-e2e.locks';
import { dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S9a fix round (CR-2, SA L-1, SA L-2): a login (`verify`) racing the panel's session
// ends, deactivation and role change, with the interleaving chosen by the test. The login takes
// the admin row FOR SHARE, then the sessions' advisory lock, then opens the session; the panel
// takes the target row (FOR UPDATE for a change, FOR SHARE for a revoke), then the same advisory
// lock. Whatever order they meet in, no session opened by a racing login outlives the panel's end.
const t = useAdminE2e();
const kit = adminAccountsKit(t);

const sessionCookie = (res: Res): string => {
  const line = setCookies(res).find((c) => c.startsWith(`${t.cookieName}=`)) ?? '';
  return line.split(';')[0] ?? '';
};

async function codeFor(admin: AdminUser): Promise<{ nonce: string; code: string }> {
  const nonce = await t.start();
  const issued = await t.issue(nonce, admin.telegramId);
  if (!issued.ok) throw new Error(`issueCode refused: ${issued.reason}`);
  return { nonce, code: issued.code };
}

/**
 * Logs `admin` in, and once its session row is written (the transaction still open, its locks
 * held) fires `panel` and holds the login until Postgres reports the panel blocked on `pattern`.
 */
async function loginRacing(
  admin: AdminUser,
  panel: () => Promise<Res>,
  pattern: string,
): Promise<{ login: Res; panel: Res; waited: boolean }> {
  const { nonce, code } = await codeFor(admin);
  const sessions = t.app().get(AdminSessionService);
  const original = sessions.open.bind(sessions);
  const started: { panel?: Promise<Res> } = {};
  let waited = false;
  sessions.open = async (...args) => {
    sessions.open = original;
    const opened = await original(...args);
    let settled = false;
    started.panel = panel().finally(() => {
      settled = true;
    });
    waited = await waitForLockWaiter(t.db(), pattern, () => settled);
    return opened;
  };
  const login = await t.verify(nonce, code).finally(() => {
    sessions.open = original;
  });
  if (started.panel === undefined) throw new Error('the panel request never started');
  return { login, panel: await started.panel, waited };
}

async function codedRequest(
  owner: Session,
  method: 'POST' | 'PATCH',
  path: string,
  confirmation: AdminConfirmationBody,
  body: object,
): Promise<() => Promise<Res>> {
  const otp = await kit.code(owner, confirmation);
  return () => kit.send(method, owner, path, { ...body, reason: REASON, otp });
}

describe('admin login vs the panel (real app, real locks)', () => {
  it('CR-2: a revoke meets a login committing its session: it waits (advisory lock) and ends that session too', async () => {
    const owner = await kit.session('OWNER');
    const op = await t.newAdmin('OPERATOR');
    const revoke = await codedRequest(
      owner,
      'POST',
      `admins/${op.id}/sessions/revoke`,
      { action: 'admins.sessionsRevoke', targetId: op.id },
      {},
    );
    const raced = await loginRacing(op, revoke, '%pg_advisory_xact_lock%');

    expect(raced.waited).toBe(true);
    expect(raced.login.statusCode).toBe(200);
    expect(raced.panel.statusCode).toBe(200);
    expect(dataOf(raced.panel)).toMatchObject({ revokedSessions: 1, currentRevoked: false });
    expect(await kit.me(sessionCookie(raced.login))).toBe(404);
    expect(await t.db().adminSession.count({ where: { adminId: op.id, revokedAt: null } })).toBe(0);
  });

  it.each([
    ['a deactivation', { isActive: false }],
    ['a role change', { role: 'SUPPORT' }],
  ] as const)(
    'SA L-2: %s waits for a login holding the admin row, then ends the new session',
    async (_name, change) => {
      const owner = await kit.session('OWNER');
      const op = await t.newAdmin('OPERATOR');
      const patch = await codedRequest(
        owner,
        'PATCH',
        `admins/${op.id}`,
        { action: 'admins.update', targetId: op.id, ...change },
        change,
      );
      const raced = await loginRacing(op, patch, '%"AdminUser"%FOR UPDATE%');

      expect(raced.waited).toBe(true);
      expect(raced.login.statusCode).toBe(200);
      expect(raced.panel.statusCode).toBe(200);
      expect(dataOf(raced.panel)).toMatchObject({ applied: true, admin: { activeSessions: 0 } });
      expect(await kit.me(sessionCookie(raced.login))).toBe(404);
    },
  );

  it('SA L-2: a login meets a deactivation holding the admin row: it waits, then CODE_EXPIRED, no session', async () => {
    const owner = await kit.session('OWNER');
    const op = await t.newAdmin('OPERATOR');
    const { nonce, code } = await codeFor(op);
    const otp = await kit.code(owner, {
      action: 'admins.update',
      targetId: op.id,
      isActive: false,
    });
    // Real production code, only the timing is chosen: once the panel holds the target row FOR
    // UPDATE, the login runs until Postgres reports it blocked on its FOR SHARE.
    const users = t.app().get(AdminUsersRepository);
    const original = users.lockById.bind(users);
    const started: { login?: Promise<Res> } = {};
    let waited = false;
    users.lockById = async (tx, id, mode) => {
      users.lockById = original;
      const locked = await original(tx, id, mode);
      let settled = false;
      started.login = t.verify(nonce, code).finally(() => {
        settled = true;
      });
      waited = await waitForLockWaiter(t.db(), '%"AdminUser"%FOR SHARE%', () => settled);
      return locked;
    };
    const res = await kit
      .send('PATCH', owner, `admins/${op.id}`, { isActive: false, reason: REASON, otp })
      .finally(() => {
        users.lockById = original;
      });
    if (started.login === undefined) throw new Error('the login never started');
    const login = await started.login;

    expect(waited).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(login.statusCode).toBe(422);
    expect(errorOf(login).code).toBe('CODE_EXPIRED');
    expect(setCookies(login)).toEqual([]);
    expect(await t.db().adminSession.count({ where: { adminId: op.id } })).toBe(0);
  });
});
