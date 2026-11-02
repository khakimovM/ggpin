import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SEC,
  sessionUserResponseSchema,
} from '@repo/shared';
import { useAuthE2e } from './auth-e2e.helpers';
import {
  bodyOf,
  cookieValue,
  cookiesFrom,
  LOGOUT,
  loginAs,
  makeUser,
  ME,
  REFRESH,
  setCookies,
  type LoggedIn,
  type Res,
} from './auth-otp.helpers';

const DAY_SEC = 86_400;

describe('refresh rotation, reuse detection and logout (real Postgres)', () => {
  const t = useAuthE2e();
  beforeEach(() => t.clock.set(new Date()));

  const refresh = (cookie: string, headers: Record<string, string> = t.csrfHeaders): Promise<Res> =>
    t.post(REFRESH, {}, { cookie, ...headers }, t.nextIp());
  const meWith = (accessCookie: string): Promise<Res> => t.get(ME, { cookie: accessCookie });
  const isCleared = (res: Res): boolean => {
    const cookies = setCookies(res);
    const gone = (name: string, path: string): boolean =>
      cookies.some(
        (c) => c.startsWith(`${name}=;`) && c.includes('Max-Age=0') && c.includes(`Path=${path}`),
      );
    return gone(ACCESS_COOKIE_NAME, '/') && gone(REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH);
  };
  const familyRows = (familyId: string) =>
    t.db.webSession.findMany({ where: { familyId }, orderBy: { createdAt: 'asc' } });

  async function freshLogin(): Promise<LoggedIn> {
    return loginAs(t, await makeUser(t));
  }

  it('rotates: new cookies with the same flags and family, old access still valid, new one works', async () => {
    const login = await freshLogin();
    t.clock.advanceSec(60);
    const res = await refresh(login.cookie);
    expect(res.statusCode).toBe(200);
    expect(sessionUserResponseSchema.parse(bodyOf(res).data).user.id).toBe(login.user.userId);

    const access = cookieValue(res, ACCESS_COOKIE_NAME);
    const next = cookieValue(res, REFRESH_COOKIE_NAME);
    expect(next).not.toBe(login.refresh);
    expect(access).not.toBe(login.access);
    expect(t.codec.verify(access, 'web', t.clock.now())?.sid).toBe(login.familyId);
    for (const line of setCookies(res)) {
      expect(line).toContain('HttpOnly');
      expect(line).toContain('SameSite=Lax');
      expect(line).toContain('Secure');
      expect(line).not.toContain('Domain');
    }
    expect(setCookies(res).find((c) => c.startsWith(REFRESH_COOKIE_NAME))).toContain(
      `Path=${REFRESH_COOKIE_PATH}`,
    );

    expect((await meWith(`${ACCESS_COOKIE_NAME}=${access}`)).statusCode).toBe(200);
    const rows = await familyRows(login.familyId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[1]?.revokedAt).toBeNull();
  });

  it('sliding expiry: every rotation pushes expiresAt to now + 30 days', async () => {
    const login = await freshLogin();
    const first = (await familyRows(login.familyId))[0];
    expect(first?.expiresAt.getTime()).toBe(t.clock.now().getTime() + REFRESH_TOKEN_TTL_SEC * 1000);

    t.clock.advanceSec(10 * DAY_SEC);
    const res = await refresh(login.cookie);
    expect(res.statusCode).toBe(200);
    const rows = await familyRows(login.familyId);
    expect(rows[1]?.expiresAt.getTime()).toBe(
      t.clock.now().getTime() + REFRESH_TOKEN_TTL_SEC * 1000,
    );

    // Past the ORIGINAL 30 days but inside the slid window: still alive.
    t.clock.advanceSec(25 * DAY_SEC);
    const again = await refresh(cookiesFrom('', cookieValue(res, REFRESH_COOKIE_NAME)));
    expect(again.statusCode).toBe(200);
  });

  it('reuse of the old refresh token -> 401 TOKEN_REUSE_DETECTED, cookies cleared, family dead', async () => {
    const login = await freshLogin();
    const rotated = await refresh(login.cookie);
    const currentAccess = `${ACCESS_COOKIE_NAME}=${cookieValue(rotated, ACCESS_COOKIE_NAME)}`;
    const currentRefresh = cookieValue(rotated, REFRESH_COOKIE_NAME);
    expect((await meWith(currentAccess)).statusCode).toBe(200);

    const replay = await refresh(login.cookie);
    expect(replay.statusCode).toBe(401);
    expect(bodyOf(replay).error?.code).toBe('TOKEN_REUSE_DETECTED');
    expect(isCleared(replay)).toBe(true);

    expect((await familyRows(login.familyId)).every((r) => r.revokedAt !== null)).toBe(true);
    // The thief's AND the victim's tokens are dead: the legit current ones too.
    expect((await meWith(currentAccess)).statusCode).toBe(401);
    expect((await refresh(cookiesFrom('', currentRefresh))).statusCode).toBe(401);
  });

  it('2 parallel refreshes of one token: one 200, one TOKEN_REUSE_DETECTED, family revoked', async () => {
    const login = await freshLogin();
    const results = await Promise.all([refresh(login.cookie), refresh(login.cookie)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const loser = results.find((r) => r.statusCode === 401);
    expect(loser === undefined ? undefined : bodyOf(loser).error?.code).toBe(
      'TOKEN_REUSE_DETECTED',
    );
    expect(loser !== undefined && isCleared(loser)).toBe(true);
    expect((await familyRows(login.familyId)).every((r) => r.revokedAt !== null)).toBe(true);
    expect((await meWith(login.accessCookie)).statusCode).toBe(401);
  });

  it('an expired refresh token -> 401 UNAUTHORIZED (not reuse), cookies cleared', async () => {
    const login = await freshLogin();
    t.clock.advanceSec(REFRESH_TOKEN_TTL_SEC + 1);
    const res = await refresh(login.cookie);
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('UNAUTHORIZED');
    expect(isCleared(res)).toBe(true);
    expect((await familyRows(login.familyId)).every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('missing, garbage and foreign refresh cookies -> 401 UNAUTHORIZED with cookies cleared', async () => {
    const none = await t.post(REFRESH, {}, t.csrfHeaders, t.nextIp());
    expect(none.statusCode).toBe(401);
    expect(bodyOf(none).error?.code).toBe('UNAUTHORIZED');
    expect(isCleared(none)).toBe(true);
    for (const value of ['garbage', 'A'.repeat(43), 'x'.repeat(5000)]) {
      const res = await refresh(`${REFRESH_COOKIE_NAME}=${value}`);
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error?.code).toBe('UNAUTHORIZED');
    }
  });

  it('a blocked account cannot refresh: 403 USER_BLOCKED and the family is revoked', async () => {
    const login = await freshLogin();
    await t.db.user.update({ where: { id: login.user.userId }, data: { isBlocked: true } });
    const res = await refresh(login.cookie);
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).error?.code).toBe('USER_BLOCKED');
    expect((await familyRows(login.familyId)).every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('refresh and logout without X-CSRF-Token or with a foreign Origin -> 404 and nothing changes', async () => {
    const login = await freshLogin();
    const bad: Record<string, string>[] = [
      { origin: t.env.WEB_URL },
      { 'x-csrf-token': '1', origin: 'https://evil.example' },
      { 'x-csrf-token': '1' },
    ];
    for (const headers of bad) {
      expect((await refresh(login.cookie, headers)).statusCode).toBe(404);
      const out = await t.post(LOGOUT, {}, { cookie: login.cookie, ...headers }, t.nextIp());
      expect(out.statusCode).toBe(404);
    }
    const rows = await familyRows(login.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
    expect((await meWith(login.accessCookie)).statusCode).toBe(200);
  });

  describe('logout', () => {
    const logout = (cookie?: string): Promise<Res> =>
      t.post(
        LOGOUT,
        {},
        { ...(cookie === undefined ? {} : { cookie }), ...t.csrfHeaders },
        t.nextIp(),
      );

    it('revokes the family, clears both cookies, answers {} and /me is 401 at once', async () => {
      const login = await freshLogin();
      expect((await meWith(login.accessCookie)).statusCode).toBe(200);
      const res = await logout(login.cookie);
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res)).toEqual({ success: true, data: {} });
      expect(isCleared(res)).toBe(true);
      expect((await meWith(login.accessCookie)).statusCode).toBe(401);
      expect((await familyRows(login.familyId)).every((r) => r.revokedAt !== null)).toBe(true);
      expect((await refresh(login.cookie)).statusCode).toBe(401);
      expect((await logout(login.cookie)).statusCode).toBe(200); // idempotent
    });

    it('without any cookie, or with only a Mini App bearer token, is a 200 {} no-op', async () => {
      const user = await makeUser(t);
      const other = await loginAs(t, user);
      const nowSec = Math.floor(t.clock.now().getTime() / 1000);
      const bearer = t.codec.sign({ typ: 'tg', sub: user.userId, iat: nowSec, exp: nowSec + 3600 });

      const variants: Record<string, string>[] = [{}, { authorization: `Bearer ${bearer}` }];
      for (const headers of variants) {
        const res = await t.post(LOGOUT, {}, { ...headers, ...t.csrfHeaders }, t.nextIp());
        expect(res.statusCode).toBe(200);
        expect(bodyOf(res)).toEqual({ success: true, data: {} });
      }
      // A web session of the same user is untouched by those calls.
      expect((await meWith(other.accessCookie)).statusCode).toBe(200);
    });
  });
});
