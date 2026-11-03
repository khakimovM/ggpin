import { OtpLoginService } from '../otp-login.service';
import { WebSessionRepository } from '../web-session.repository';
import { WebSessionService } from '../web-session.service';
import { useAuthE2e, type AuthE2e } from './auth-e2e.helpers';
import {
  cookieValue,
  LOGOUT,
  makeUser,
  ME,
  REFRESH,
  SESSIONS,
  loginAs,
  type LoggedIn,
  type Res,
} from './auth-otp.helpers';

const POLL_MS = 20;
const WAIT_LIMIT_MS = 5000;

// Polls Postgres until some backend is waiting on a lock. With the family lock the revoke waits
// on the advisory lock; without it, on the row lock of the token the refresh retired. Either way
// it is the proof that the revoke has started and is parked behind the open refresh transaction,
// which is exactly the interleaving of the bug. Tests run in band, so nothing else waits.
async function waitUntilSomeoneWaitsOnALock(db: AuthE2e['db']): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('the revoke never started waiting behind the open refresh transaction');
}

interface RevokePath {
  readonly name: string;
  readonly fire: (t: AuthE2e, login: LoggedIn) => Promise<unknown>;
  readonly check: (result: unknown) => void;
}

const statusIs200 = (result: unknown): void => {
  expect((result as Res).statusCode).toBe(200);
};

const PATHS: readonly RevokePath[] = [
  {
    name: 'the bot "this was not me" button on the new-login notice (se:)',
    fire: (t, login) =>
      t
        .app()
        .get(WebSessionService)
        .endSessionFromBot({
          telegramId: BigInt(login.user.telegramId),
          familyId: login.familyId,
          now: t.clock.now(),
        }),
    // true = it ended a live row; false would make the bot say "already ended".
    check: (result) => {
      expect(result).toBe(true);
    },
  },
  {
    name: 'the bot "this was not me" button on the code message after use (ld:)',
    fire: (t, login) =>
      t
        .app()
        .get(OtpLoginService)
        .deny({
          nonce: login.nonce,
          telegramId: BigInt(login.user.telegramId),
          now: t.clock.now(),
        }),
    check: (result) => {
      expect(result).toBe('sessionEnded');
    },
  },
  {
    name: 'DELETE /auth/sessions/:id',
    fire: (t, login) =>
      t.del(
        `${SESSIONS}/${login.familyId}`,
        { cookie: login.accessCookie, ...t.csrfHeaders },
        t.nextIp(),
      ),
    check: statusIs200,
  },
  {
    name: 'POST /auth/logout',
    fire: (t, login) => t.post(LOGOUT, {}, { cookie: login.cookie, ...t.csrfHeaders }, t.nextIp()),
    check: statusIs200,
  },
];

describe('revoking a session family while a refresh is in flight (real Postgres)', () => {
  const t = useAuthE2e();
  beforeEach(() => t.clock.set(new Date()));

  it.each(PATHS)(
    'leaves no live session when it runs behind an open refresh: $name',
    async (path) => {
      const login = await loginAs(t, await makeUser(t));
      const repo = t.app().get(WebSessionRepository);

      // The refresh is the real production code path (HTTP -> rotate). The spy only lets the
      // test park that transaction right after its INSERT, before it commits.
      const original = repo.insert.bind(repo);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let reached!: () => void;
      const refreshIsOpen = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let parked = false;
      const spy = jest.spyOn(repo, 'insert').mockImplementation(async (data, db) => {
        await original(data, db);
        if (db !== undefined && !parked) {
          parked = true;
          reached();
          await gate;
        }
      });

      try {
        const refreshing = t.post(
          REFRESH,
          {},
          { cookie: login.cookie, ...t.csrfHeaders },
          t.nextIp(),
        );
        await refreshIsOpen; // T1 holds its transaction: R1 retired, R2 inserted, not committed.

        const revoking = path.fire(t, login);
        await waitUntilSomeoneWaitsOnALock(t.db); // T2 started and is parked behind T1.
        open(); // T1 commits.

        const [refreshed, revoked] = await Promise.all([refreshing, revoking]);
        expect(refreshed.statusCode).toBe(200); // the refresh won the race; the revoke must still win the war
        path.check(revoked);

        const live = await t.db.webSession.count({
          where: { familyId: login.familyId, revokedAt: null },
        });
        expect(live).toBe(0);
        const active = await t
          .app()
          .get(WebSessionService)
          .isFamilyActive({ userId: login.user.userId, familyId: login.familyId }, t.clock.now());
        expect(active).toBe(false);

        // Both access tokens (the old one and the one the refresh just issued) are dead.
        const fresh = `access_token=${cookieValue(refreshed, 'access_token')}`;
        expect((await t.get(ME, { cookie: login.accessCookie })).statusCode).toBe(401);
        expect((await t.get(ME, { cookie: fresh })).statusCode).toBe(401);
      } finally {
        open();
        spy.mockRestore();
      }
    },
  );
});
