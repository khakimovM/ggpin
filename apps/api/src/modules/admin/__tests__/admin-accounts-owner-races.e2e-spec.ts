import type { AdminConfirmationBody } from '@repo/shared';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import { AdminConfirmAdminsView } from '../confirm/admin-confirm-admins.view';
import { REASON, adminAccountsKit } from './admin-accounts-write.e2e-kit';
import { useAdminE2e } from './admin-e2e.harness';
import { errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S9a SA S9a-I2: PATCH of an OWNER row. Under the locks the acting OWNER holds its own
// row FOR SHARE and then wants the target FOR UPDATE, so two OWNERs patching each other (or one
// patching itself twice) would upgrade crosswise into a deadlock (40P01 -> 500). The service
// refuses an OWNER target with 400 OWNER_ROW BEFORE any lock. To prove that check is what keeps
// the 500 away, the test gets REAL codes for these bodies (the confirm view refuses an OWNER
// target, so it is told to issue them as for a session revoke of the same admin) and holds both
// requests at the target lock if either ever reaches it.
const t = useAdminE2e();
const kit = adminAccountsKit(t);

const noDeadlockLogged = () => expect(t.logs.text()).not.toMatch(/40P01|deadlock/i);

/** Real codes for `admins.update` bodies on OWNER rows (the view would refuse them). */
async function codesFor(pairs: readonly [Session, AdminConfirmationBody][]) {
  const views = t.app().get(AdminConfirmAdminsView);
  const original = views.view.bind(views);
  views.view = (body) =>
    original(
      body.action === 'admins.update'
        ? { action: 'admins.sessionsRevoke', targetId: body.targetId }
        : body,
    );
  try {
    const codes = [];
    for (const [who, body] of pairs) codes.push(await kit.code(who, body));
    return codes;
  } finally {
    views.view = original;
  }
}

/** Runs both PATCHes at once; a request that reaches the target lock waits for the other. */
async function bothAtOnce(calls: readonly (() => ReturnType<typeof kit.send>)[]): Promise<{
  statuses: number[];
  reachedLock: number;
  bodies: Awaited<ReturnType<typeof kit.send>>[];
}> {
  const users = t.app().get(AdminUsersRepository);
  const original = users.lockById.bind(users);
  let reachedLock = 0;
  let release = (): void => undefined;
  const bothIn = new Promise<void>((resolve) => {
    release = resolve;
  });
  users.lockById = async (tx, id, mode) => {
    reachedLock += 1;
    if (reachedLock >= 2) release();
    await Promise.race([bothIn, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    return original(tx, id, mode);
  };
  const bodies = await Promise.all(calls.map((call) => call())).finally(() => {
    users.lockById = original;
  });
  return { statuses: bodies.map((res) => res.statusCode), reachedLock, bodies };
}

describe('PATCH of an OWNER row under parallel calls (SA S9a-I2)', () => {
  it('two OWNERs rename each other at the same moment: both 400 OWNER_ROW, no lock taken, no 500', async () => {
    const [a, b] = [await kit.session('OWNER'), await kit.session('OWNER')];
    const toB = { action: 'admins.update', targetId: b.admin.id, name: 'B2' } as const;
    const toA = { action: 'admins.update', targetId: a.admin.id, name: 'A2' } as const;
    const [otpA, otpB] = await codesFor([
      [a, toB],
      [b, toA],
    ]);
    const raced = await bothAtOnce([
      () => kit.send('PATCH', a, `admins/${b.admin.id}`, { name: 'B2', reason: REASON, otp: otpA }),
      () => kit.send('PATCH', b, `admins/${a.admin.id}`, { name: 'A2', reason: REASON, otp: otpB }),
    ]);

    expect(raced.statuses).toEqual([400, 400]);
    for (const res of raced.bodies) {
      expect(errorOf(res).details).toEqual([{ path: 'id', code: 'OWNER_ROW' }]);
    }
    expect(raced.reachedLock).toBe(0);
    noDeadlockLogged();
  });

  it('one OWNER patches its own row twice at once: both 400 OWNER_ROW, no lock taken, no 500', async () => {
    const a = await kit.session('OWNER');
    const first = { action: 'admins.update', targetId: a.admin.id, name: 'Self 1' } as const;
    const second = { action: 'admins.update', targetId: a.admin.id, name: 'Self 2' } as const;
    const [otp1, otp2] = await codesFor([
      [a, first],
      [a, second],
    ]);
    const path = `admins/${a.admin.id}`;
    const raced = await bothAtOnce([
      () => kit.send('PATCH', a, path, { name: 'Self 1', reason: REASON, otp: otp1 }),
      () => kit.send('PATCH', a, path, { name: 'Self 2', reason: REASON, otp: otp2 }),
    ]);

    expect(raced.statuses).toEqual([400, 400]);
    for (const res of raced.bodies) {
      expect(errorOf(res).details).toEqual([{ path: 'id', code: 'OWNER_ROW' }]);
    }
    expect(raced.reachedLock).toBe(0);
    expect((await t.db().adminUser.findUniqueOrThrow({ where: { id: a.admin.id } })).name).toBe(
      a.admin.name,
    );
    noDeadlockLogged();
  });
});
