import { createHash } from 'node:crypto';
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SEC,
  loginStartResponseSchema,
  loginStatusResponseSchema,
  meSchema,
  OTP_CODE_TTL_SEC,
  OTP_MAX_ATTEMPTS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SEC,
} from '@repo/shared';
import { useAuthE2e } from './auth-e2e.helpers';
import {
  bodyOf,
  botIssue,
  makeUser,
  ME,
  setCookies,
  START,
  startNonce,
  statusUrl,
  VERIFY,
  verify,
} from './auth-otp.helpers';

const wrongCodeFor = (code: string): string =>
  String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('web OTP login (real Postgres)', () => {
  const t = useAuthE2e();
  beforeEach(() => t.clock.set(new Date()));

  const statusOf = async (nonce: string): Promise<string | undefined> => {
    const res = await t.get(statusUrl(nonce), {}, t.nextIp());
    return res.statusCode === 200
      ? loginStatusResponseSchema.parse(bodyOf(res).data).status
      : undefined;
  };

  it('full journey: start -> bot code -> CODE_SENT -> verify -> exact cookies -> GET /me', async () => {
    const user = await makeUser(t);
    const started = await t.post(START, {}, t.csrfHeaders, t.nextIp());
    expect(started.statusCode).toBe(200);
    const { nonce, botUrl } = loginStartResponseSchema.parse(bodyOf(started).data);
    t.trackNonce(nonce);
    expect(botUrl).toBe(`https://t.me/${t.env.TELEGRAM_BOT_USERNAME}?start=login_${nonce}`);
    expect(await statusOf(nonce)).toBe('PENDING');

    const code = await botIssue(t, nonce, user.telegramId);
    expect(await statusOf(nonce)).toBe('CODE_SENT');

    const ua = 'Mozilla/5.0 (E2E)';
    const res = await verify(t, nonce, code, { 'user-agent': ua }, '203.0.113.45');
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(Object.keys(body.data ?? {})).toEqual(['user']);
    expect(meSchema.parse(body.data?.['user']).id).toBe(user.userId);

    // Exact flags: host-only (no Domain), HttpOnly, Lax, Secure (NODE_ENV=test), right paths.
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(2);
    const attrs = (name: string): string[] =>
      (cookies.find((c) => c.startsWith(`${name}=`)) ?? '').split('; ').slice(1).sort();
    expect(attrs(ACCESS_COOKIE_NAME)).toEqual(
      [
        'HttpOnly',
        `Max-Age=${String(ACCESS_TOKEN_TTL_SEC)}`,
        'Path=/',
        'SameSite=Lax',
        'Secure',
      ].sort(),
    );
    expect(attrs(REFRESH_COOKIE_NAME)).toEqual(
      [
        'HttpOnly',
        `Max-Age=${String(REFRESH_TOKEN_TTL_SEC)}`,
        `Path=${REFRESH_COOKIE_PATH}`,
        'SameSite=Lax',
        'Secure',
      ].sort(),
    );

    const access = (cookies.find((c) => c.startsWith(`${ACCESS_COOKIE_NAME}=`)) ?? '')
      .split(';')[0]
      ?.slice(ACCESS_COOKIE_NAME.length + 1);
    const claims = t.codec.verify(access ?? '', 'web', t.clock.now());
    expect(claims).toMatchObject({ typ: 'web', sub: user.userId });
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(ACCESS_TOKEN_TTL_SEC);

    const me = await t.get(ME, { cookie: `${ACCESS_COOKIE_NAME}=${access ?? ''}` });
    expect(me.statusCode).toBe(200);
    expect(meSchema.parse(bodyOf(me).data).id).toBe(user.userId);

    // Only the masked network and a bounded UA are stored.
    const row = await t.db.webSession.findFirst({ where: { userId: user.userId } });
    expect(row?.ip).toBe('203.0.113.x');
    expect(row?.userAgent).toBe(ua);
    expect(await statusOf(nonce)).toBe('EXPIRED'); // USED is reported as EXPIRED
  });

  it('stores only an HMAC of the code: not the code, not an unpeppered sha256', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    const row = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } });
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).not.toBe(createHash('sha256').update(code).digest('hex'));
    expect(row.codeHash).not.toBe(createHash('sha256').update(`${nonce}:${code}`).digest('hex'));
    expect(row.attempts).toBe(0);
  });

  it('five wrong codes report attemptsLeft 4..0; the 6th, even correct, is CODE_EXPIRED', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      const res = await verify(t, nonce, wrongCodeFor(code));
      expect(res.statusCode).toBe(422);
      expect(bodyOf(res).error).toMatchObject({
        code: 'CODE_INVALID',
        details: { attemptsLeft: OTP_MAX_ATTEMPTS - 1 - i },
      });
    }
    const sixth = await verify(t, nonce, code);
    expect(sixth.statusCode).toBe(422);
    expect(bodyOf(sixth).error?.code).toBe('CODE_EXPIRED');
    expect(setCookies(sixth)).toHaveLength(0);
    expect(await statusOf(nonce)).toBe('EXPIRED');
    expect(await t.db.webSession.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('a PENDING nonce expires after its 10 minutes (status and issueCode)', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    t.clock.advanceSec(599);
    expect(await statusOf(nonce)).toBe('PENDING');
    t.clock.advanceSec(2);
    expect(await statusOf(nonce)).toBe('EXPIRED');
    await expect(botIssue(t, nonce, user.telegramId)).rejects.toThrow('expired');
  });

  it('a sent code expires 180 s after it was sent, not with the nonce', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    t.clock.advanceSec(400); // late in the nonce window: the code still gets its full 3 minutes
    const code = await botIssue(t, nonce, user.telegramId);
    t.clock.advanceSec(OTP_CODE_TTL_SEC - 1);
    expect(await statusOf(nonce)).toBe('CODE_SENT');
    t.clock.advanceSec(2);
    expect(await statusOf(nonce)).toBe('EXPIRED');
    const res = await verify(t, nonce, code);
    expect(bodyOf(res).error?.code).toBe('CODE_EXPIRED');
  });

  it('replaying a used nonce -> CODE_EXPIRED and status EXPIRED; one session only', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    expect((await verify(t, nonce, code)).statusCode).toBe(200);
    const replay = await verify(t, nonce, code);
    expect(replay.statusCode).toBe(422);
    expect(bodyOf(replay).error?.code).toBe('CODE_EXPIRED');
    expect(await statusOf(nonce)).toBe('EXPIRED');
    expect(await t.db.webSession.count({ where: { userId: user.userId } })).toBe(1);
  });

  it('unknown nonce: status 404, verify CODE_EXPIRED; malformed nonce on status is 404 too', async () => {
    const unknown = 'A'.repeat(43);
    expect((await t.get(statusUrl(unknown), {}, t.nextIp())).statusCode).toBe(404);
    expect((await t.get(statusUrl('short'), {}, t.nextIp())).statusCode).toBe(404);
    const res = await verify(t, unknown, '123456');
    expect(res.statusCode).toBe(422);
    expect(bodyOf(res).error?.code).toBe('CODE_EXPIRED');
  });

  it('rejects a malformed code, a malformed nonce and extra keys with 400', async () => {
    const nonce = await startNonce(t);
    const send = (payload: unknown) => t.post(VERIFY, payload, t.csrfHeaders, t.nextIp());
    for (const payload of [
      { nonce, code: '12345' },
      { nonce, code: '1234567' },
      { nonce, code: '12a456' },
      { nonce, code: 123456 },
      { nonce: 'short', code: '123456' },
      { nonce, code: '123456', extra: true },
      { code: '123456' },
    ]) {
      const res = await send(payload);
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res).error?.code).toBe('VALIDATION_ERROR');
    }
    expect((await send({ nonce, code: '123456' })).statusCode).toBe(422); // still PENDING
    const extra = await t.post(START, { extra: 1 }, t.csrfHeaders, t.nextIp());
    expect(extra.statusCode).toBe(400);
  });

  it('10 parallel wrong verifies: attempts is exactly 5 and each attempt reports its own count', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => verify(t, nonce, wrongCodeFor(code))),
    );
    const bodies = results.map(bodyOf);
    expect(bodies.filter((b) => b.error?.code === 'CODE_INVALID')).toHaveLength(OTP_MAX_ATTEMPTS);
    expect(bodies.filter((b) => b.error?.code === 'CODE_EXPIRED')).toHaveLength(
      10 - OTP_MAX_ATTEMPTS,
    );
    const left = bodies
      .flatMap((b) => (b.error?.code === 'CODE_INVALID' ? [b.error.details?.['attemptsLeft']] : []))
      .sort();
    expect(left).toEqual([0, 1, 2, 3, 4]);
    const row = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } });
    expect(row.attempts).toBe(OTP_MAX_ATTEMPTS);
    expect((await verify(t, nonce, code)).statusCode).toBe(422);
  });

  it('2 parallel correct verifies: exactly one 200 and exactly one session family', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    const results = await Promise.all([verify(t, nonce, code), verify(t, nonce, code)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    const loser = results.find((r) => r.statusCode === 422);
    expect(loser === undefined ? undefined : bodyOf(loser).error?.code).toBe('CODE_EXPIRED');
    const rows = await t.db.webSession.findMany({ where: { userId: user.userId } });
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('a blocked user gets USER_BLOCKED and no session; an unknown account gets CODE_EXPIRED', async () => {
    const blocked = await makeUser(t);
    await t.db.user.update({ where: { id: blocked.userId }, data: { isBlocked: true } });
    const n1 = await startNonce(t);
    const c1 = await botIssue(t, n1, blocked.telegramId);
    const res = await verify(t, n1, c1);
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).error?.code).toBe('USER_BLOCKED');
    expect(await t.db.webSession.count({ where: { userId: blocked.userId } })).toBe(0);

    // The bot normally creates the user first; a code for an id with no account is dead.
    const ghost = t.newTelegramId();
    const n2 = await startNonce(t);
    const c2 = await botIssue(t, n2, ghost);
    expect(bodyOf(await verify(t, n2, c2)).error?.code).toBe('CODE_EXPIRED');
  });

  it('verify, refresh-less POSTs without X-CSRF-Token or with a foreign Origin -> 404 (D-26)', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    const body = { nonce, code };
    const noHeader = await t.post(VERIFY, body, { origin: t.env.WEB_URL }, t.nextIp());
    const foreign = await t.post(
      VERIFY,
      body,
      { 'x-csrf-token': '1', origin: 'https://evil.example' },
      t.nextIp(),
    );
    const noOrigin = await t.post(VERIFY, body, { 'x-csrf-token': '1' }, t.nextIp());
    for (const res of [noHeader, foreign, noOrigin]) expect(res.statusCode).toBe(404);
    expect((await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } })).attempts).toBe(0); // the guard stopped it before any attempt was counted
    expect((await t.post(START, {}, { origin: t.env.WEB_URL }, t.nextIp())).statusCode).toBe(404);
  });

  it('the 31st start from one IP within a minute -> 429', async () => {
    const ip = t.nextIp();
    const codes: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const res = await t.post(START, {}, t.csrfHeaders, ip);
      codes.push(res.statusCode);
      if (res.statusCode === 200) t.trackNonce(String(bodyOf(res).data?.['nonce']));
    }
    expect(codes).toEqual([...Array<number>(30).fill(200), 429]);
  });
});
