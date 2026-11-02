import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, webAppLoginResponseSchema } from '@repo/shared';
import { UsersService } from '../../users/users.service';
import { useAuthE2e } from './auth-e2e.helpers';
import {
  bodyOf,
  botIssue,
  cookieValue,
  cookiesFrom,
  loginAs,
  makeUser,
  ME,
  REFRESH,
  SESSIONS,
  startNonce,
  statusUrl,
  verify,
  LOGOUT,
  VERIFY,
} from './auth-otp.helpers';

const WEBAPP = '/api/v1/auth/telegram/webapp';

// Gaps found when auditing the phase-2 plan: input validation of the Mini App login, the verify
// throttle, mixed bot + Mini App creation races, the self-referral path through HTTP, blocked
// web-cookie sessions, session-only scoping of /me and "no stored hash ever leaves the API".
describe('auth abuse cases (real Postgres)', () => {
  const t = useAuthE2e();
  const webapp = (payload: unknown) => t.post(WEBAPP, payload, t.csrfHeaders, t.nextIp());

  it('POST /auth/telegram/webapp: extra keys, missing or non-string initData -> 400 and no account', async () => {
    const telegramId = t.newTelegramId();
    const initData = t.initDataFor(telegramId);
    for (const payload of [
      { initData, extra: true },
      { initData, token: 'x' },
      {},
      { initData: 123 },
      { initData: null },
      { initData: '' },
      [],
    ]) {
      const res = await webapp(payload);
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res).error?.code).toBe('VALIDATION_ERROR');
    }
    expect(await t.db.user.count({ where: { telegramId: BigInt(telegramId) } })).toBe(0);
    expect((await webapp({ initData })).statusCode).toBe(200); // the same body without the extras
  });

  it('the 6th POST /auth/telegram/verify from one IP within a minute -> 429 RATE_LIMITED', async () => {
    const ip = t.nextIp();
    const nonce = 'B'.repeat(43);
    const codes: number[] = [];
    let last: Awaited<ReturnType<typeof verify>> | undefined;
    for (let i = 0; i < 6; i += 1) {
      last = await t.post(VERIFY, { nonce, code: '123456' }, t.csrfHeaders, ip);
      codes.push(last.statusCode);
    }
    expect(codes).toEqual([422, 422, 422, 422, 422, 429]);
    expect(last === undefined ? undefined : bodyOf(last).error?.code).toBe('RATE_LIMITED');
    expect(last?.headers['retry-after']).toBeDefined();
  });

  it('20 parallel creations of one Telegram id, half bot-side, half Mini App logins -> 1 User, 1 Wallet', async () => {
    const telegramId = t.newTelegramId();
    const users = t.app().get(UsersService);
    const initData = t.initDataFor(telegramId);
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () =>
        users.ensureTelegramUser(
          { telegramId: BigInt(telegramId), firstName: 'Bot' },
          { now: t.clock.now() },
        ),
      ),
      ...Array.from({ length: 10 }, () => webapp({ initData })),
    ]);
    const http = results.slice(10) as Awaited<ReturnType<typeof webapp>>[];
    expect(http.map((r) => r.statusCode)).toEqual(Array.from({ length: 10 }, () => 200));
    const row = await t.db.user.findUniqueOrThrow({ where: { telegramId: BigInt(telegramId) } });
    for (const res of http) {
      expect(webAppLoginResponseSchema.parse(bodyOf(res).data).user.id).toBe(row.id);
    }
    expect(await t.db.user.count({ where: { telegramId: BigInt(telegramId) } })).toBe(1);
    expect(await t.db.wallet.count({ where: { userId: row.id } })).toBe(1);
  });

  it('a Mini App login with ref_<own code> never makes a user their own inviter', async () => {
    const telegramId = t.newTelegramId();
    const first = await webapp({ initData: t.initDataFor(telegramId) });
    const { user } = webAppLoginResponseSchema.parse(bodyOf(first).data);
    const again = await webapp({
      initData: t.initDataFor(telegramId, { startParam: `ref_${user.referralCode}` }),
    });
    expect(again.statusCode).toBe(200);
    const row = await t.db.user.findUniqueOrThrow({ where: { telegramId: BigInt(telegramId) } });
    expect(row.referredById).toBeNull();
  });

  it('a blocked user with a live web cookie: GET /me -> 403 USER_BLOCKED; unblocked -> 200', async () => {
    const user = await makeUser(t);
    const login = await loginAs(t, user);
    await t.db.user.update({ where: { id: user.userId }, data: { isBlocked: true } });
    const res = await t.get(ME, { cookie: login.accessCookie });
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).error?.code).toBe('USER_BLOCKED');
    await t.db.user.update({ where: { id: user.userId }, data: { isBlocked: false } });
    expect((await t.get(ME, { cookie: login.accessCookie })).statusCode).toBe(200);
  });

  it('/me is scoped by the session alone: a userId in the query or a header is ignored', async () => {
    const [a, b] = [await makeUser(t), await makeUser(t)];
    const [loginA, loginB] = [await loginAs(t, a), await loginAs(t, b)];
    const idOf = (res: Awaited<ReturnType<typeof t.get>>) => bodyOf(res).data?.['id'];
    const attempts = { 'x-user-id': b.userId, 'x-telegram-id': String(b.telegramId) };

    expect(idOf(await t.get(ME, { cookie: loginA.accessCookie }))).toBe(a.userId);
    expect(idOf(await t.get(ME, { cookie: loginB.accessCookie }))).toBe(b.userId);
    const spoofed = await t.get(`${ME}?userId=${b.userId}`, {
      cookie: loginA.accessCookie,
      ...attempts,
    });
    expect(idOf(spoofed)).toBe(a.userId);
    expect(spoofed.body).not.toContain(String(b.telegramId));
  });

  it('no response body ever carries codeHash, refreshHash or their values', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    const bodies: string[] = [];
    const seen = (res: Awaited<ReturnType<typeof t.get>>): typeof res => {
      bodies.push(res.body);
      return res;
    };

    seen(await t.get(statusUrl(nonce), {}, t.nextIp())); // CODE_SENT
    seen(await verify(t, nonce, String((Number(code) + 1) % 1_000_000).padStart(6, '0')));
    const ok = seen(await verify(t, nonce, code));
    expect(ok.statusCode).toBe(200);
    const access = cookieValue(ok, ACCESS_COOKIE_NAME);
    const cookie = cookiesFrom(access, cookieValue(ok, REFRESH_COOKIE_NAME));
    seen(await t.get(statusUrl(nonce), {}, t.nextIp())); // used
    seen(await t.get(ME, { cookie }));
    seen(await t.get(SESSIONS, { cookie }));
    const rotated = seen(await t.post(REFRESH, {}, { cookie, ...t.csrfHeaders }, t.nextIp()));
    expect(rotated.statusCode).toBe(200);
    seen(await t.post(REFRESH, {}, { cookie, ...t.csrfHeaders }, t.nextIp())); // reuse error
    seen(await t.post(LOGOUT, {}, { cookie, ...t.csrfHeaders }, t.nextIp()));

    const loginRow = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } });
    const sessionRows = await t.db.webSession.findMany({ where: { userId: user.userId } });
    const hashes = [
      loginRow.codeHash,
      ...sessionRows.map((r) => r.refreshHash),
      ...[cookieValue(ok, REFRESH_COOKIE_NAME), cookieValue(rotated, REFRESH_COOKIE_NAME)],
    ];
    expect(hashes.filter((h) => h !== null && h !== '')).not.toHaveLength(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/codeHash|refreshHash|code_hash|refresh_hash/i);
      for (const secret of hashes) {
        if (secret !== null && secret !== '') expect(body).not.toContain(secret);
      }
    }
  });
});
