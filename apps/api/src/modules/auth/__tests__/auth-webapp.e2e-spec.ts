import {
  ACCESS_COOKIE_NAME,
  MINI_APP_TOKEN_TTL_SEC,
  meSchema,
  webAppLoginResponseSchema,
} from '@repo/shared';
import { RedisService } from '../../../infra/redis/redis.service';
import { webappLimitKey } from '../mini-app-auth.service';
import { buildInitData, fixtureBotToken } from './init-data.fixtures';
import { useAuthE2e, type AuthE2e } from './auth-e2e.helpers';

const WEBAPP = '/api/v1/auth/telegram/webapp';
const ME = '/api/v1/me';

type Body = { success: boolean; data?: Record<string, unknown>; error?: { code: string } };
type Res = Awaited<ReturnType<AuthE2e['get']>>;
const body = (res: Res): Body => res.json<Body>();
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// Each describe boots its own app, so each has its own per-IP budget (120/min) on the webapp
// route. The per-account budget (10/min) lives in Redis and is keyed by a fresh Telegram id.

describe('POST /auth/telegram/webapp + /me (real Postgres)', () => {
  const t = useAuthE2e();
  let token = '';
  let telegramId = 0;

  it('valid initData -> 200 { token, expiresIn: 3600, user } matching the shared schemas strictly', async () => {
    telegramId = t.newTelegramId();
    const res = await t.post(WEBAPP, { initData: t.initDataFor(telegramId) }, t.csrfHeaders);
    expect(res.statusCode).toBe(200);
    const { success, data } = body(res);
    expect(success).toBe(true);
    const parsed = webAppLoginResponseSchema.strict().parse(data);
    meSchema.strict().parse(parsed.user);
    expect(parsed.expiresIn).toBe(MINI_APP_TOKEN_TTL_SEC);
    expect(parsed.expiresIn).toBe(3600);
    expect(parsed.user).toMatchObject({
      telegramId: String(telegramId),
      username: `e2e_${String(telegramId)}`,
      firstName: 'E2E',
      locale: 'ru', // from language_code
      phoneLinked: false,
      photoUrl: null,
    });
    // Internal columns never reach the wire.
    expect(Object.keys(parsed.user).sort()).toEqual(Object.keys(meSchema.shape).sort());
    token = parsed.token;
    const claims = t.codec.verify(token, 'tg', t.clock.now());
    expect(claims).toMatchObject({ typ: 'tg', sub: parsed.user.id });
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(MINI_APP_TOKEN_TTL_SEC);
  });

  it('creates the User with its Wallet', async () => {
    const user = await t.db.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      include: { wallet: true },
    });
    expect(user?.wallet).not.toBeNull();
  });

  it('forged initData (wrong hash) -> 401 INITDATA_INVALID, envelope only', async () => {
    const forged = buildInitData({
      botToken: fixtureBotToken('999999', 'z'),
      authDate: Math.floor(t.clock.now().getTime() / 1000),
      user: { id: t.newTelegramId(), first_name: 'Evil' },
    });
    const res = await t.post(WEBAPP, { initData: forged }, t.csrfHeaders);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'INITDATA_INVALID', message: 'errors.INITDATA_INVALID' },
    });
    expect(res.body).not.toContain('Evil');
  });

  it('expired initData (signed, older than the max age) -> 401 INITDATA_EXPIRED', async () => {
    const stale = t.initDataFor(t.newTelegramId(), { ageSec: t.env.TG_INITDATA_MAX_AGE_SEC + 1 });
    const res = await t.post(WEBAPP, { initData: stale }, t.csrfHeaders);
    expect(res.statusCode).toBe(401);
    expect(body(res).error?.code).toBe('INITDATA_EXPIRED');
  });

  it('the token works on GET /me and returns the same Me', async () => {
    const res = await t.get(ME, bearer(token));
    expect(res.statusCode).toBe(200);
    const me = meSchema.strict().parse(body(res).data);
    expect(me.telegramId).toBe(String(telegramId));
  });

  it('PATCH /me with the bearer and NO CSRF header -> 200 with the new locale', async () => {
    const res = await t.patch(ME, { locale: 'uz' }, bearer(token));
    expect(res.statusCode).toBe(200);
    expect(meSchema.strict().parse(body(res).data).locale).toBe('uz');
    const again = await t.get(ME, bearer(token));
    expect(meSchema.parse(body(again).data).locale).toBe('uz');
  });

  it('PATCH /me with extra keys or a bad locale -> 400 VALIDATION_ERROR', async () => {
    for (const payload of [{ locale: 'uz', isBlocked: false }, { locale: 'en' }, {}]) {
      const res = await t.patch(ME, payload, bearer(token));
      expect(res.statusCode).toBe(400);
      expect(body(res).error?.code).toBe('VALIDATION_ERROR');
    }
    const login = await t.post(WEBAPP, { initData: 'x', extra: 1 }, t.csrfHeaders);
    expect(login.statusCode).toBe(400);
  });

  it('no token -> 401 UNAUTHORIZED; garbage bearer -> 401', async () => {
    const none = await t.get(ME);
    expect(none.statusCode).toBe(401);
    expect(body(none).error?.code).toBe('UNAUTHORIZED');
    expect((await t.get(ME, bearer('garbage'))).statusCode).toBe(401);
  });

  it('a tg token sent as the access_token cookie -> 401', async () => {
    const res = await t.get(ME, { cookie: `${ACCESS_COOKIE_NAME}=${token}` });
    expect(res.statusCode).toBe(401);
    expect(body(res).error?.code).toBe('UNAUTHORIZED');
  });

  it('a web token sent as a Bearer -> 401', async () => {
    const user = await t.db.user.findUniqueOrThrow({ where: { telegramId: BigInt(telegramId) } });
    const nowSec = Math.floor(t.clock.now().getTime() / 1000);
    const web = t.codec.sign({
      typ: 'web',
      sub: user.id,
      sid: 'x',
      iat: nowSec,
      exp: nowSec + 900,
    });
    expect((await t.get(ME, bearer(web))).statusCode).toBe(401);
  });

  it('blocked user: existing token -> 403 USER_BLOCKED; a new login -> 403 USER_BLOCKED', async () => {
    const where = { telegramId: BigInt(telegramId) };
    await t.db.user.update({ where, data: { isBlocked: true } });
    const me = await t.get(ME, bearer(token));
    expect(me.statusCode).toBe(403);
    expect(body(me).error?.code).toBe('USER_BLOCKED');
    const login = await t.post(WEBAPP, { initData: t.initDataFor(telegramId) }, t.csrfHeaders);
    expect(login.statusCode).toBe(403);
    expect(body(login).error?.code).toBe('USER_BLOCKED');
    await t.db.user.update({ where, data: { isBlocked: false } });
    expect((await t.get(ME, bearer(token))).statusCode).toBe(200);
  });

  it('the token expires after expiresIn (clock override, no sleeping)', async () => {
    t.clock.advanceSec(MINI_APP_TOKEN_TTL_SEC - 1);
    expect((await t.get(ME, bearer(token))).statusCode).toBe(200);
    t.clock.advanceSec(1);
    const res = await t.get(ME, bearer(token));
    expect(res.statusCode).toBe(401);
    expect(body(res).error?.code).toBe('UNAUTHORIZED');
  });

  it('health stays public', async () => {
    expect((await t.get('/api/v1/health/live')).statusCode).toBe(200);
  });
});

describe('referral from start_param (real Postgres)', () => {
  const t = useAuthE2e();

  const login = async (telegramId: number, startParam?: string) => {
    const res = await t.post(
      WEBAPP,
      { initData: t.initDataFor(telegramId, startParam === undefined ? {} : { startParam }) },
      t.csrfHeaders,
    );
    expect(res.statusCode).toBe(200);
    return webAppLoginResponseSchema.parse(body(res).data).user;
  };
  const referredBy = async (telegramId: number): Promise<string | null> =>
    (await t.db.user.findUniqueOrThrow({ where: { telegramId: BigInt(telegramId) } })).referredById;

  it('ref_<A> binds on the first login only; later ref_ never rebinds or binds an existing user', async () => {
    const a = t.newTelegramId();
    const b = t.newTelegramId();
    const c = t.newTelegramId();

    const userA = await login(a); // 1
    const first = await login(b, `ref_${userA.referralCode}`); // 2: B is new -> binds to A
    expect(await referredBy(b)).toBe(userA.id);

    const userC = await login(c); // 3
    await login(b, `ref_${userC.referralCode}`); // 4: B exists -> still A
    expect(await referredBy(b)).toBe(userA.id);

    await login(a, `ref_${first.referralCode}`); // 5: A exists -> not bound to B (no cycle)
    expect(await referredBy(a)).toBeNull();
  });
});

describe('rate limits on the webapp login (real Postgres and Redis)', () => {
  const t = useAuthE2e();
  const track = (telegramId: number): number => {
    t.trackRedisKey(webappLimitKey(telegramId));
    return telegramId;
  };

  it('10 logins a minute per Telegram account, the 11th -> 429 RATE_LIMITED', async () => {
    const initData = t.initDataFor(track(t.newTelegramId()));
    for (let i = 1; i <= 10; i += 1) {
      const res = await t.post(WEBAPP, { initData }, t.csrfHeaders);
      expect(res.statusCode).toBe(200);
    }
    const eleventh = await t.post(WEBAPP, { initData }, t.csrfHeaders);
    expect(eleventh.statusCode).toBe(429);
    expect(body(eleventh).error?.code).toBe('RATE_LIMITED');
  });

  it('the budget is per account: another account behind the same IP still gets in', async () => {
    const ip = t.nextIp();
    const busy = t.initDataFor(track(t.newTelegramId()));
    for (let i = 0; i < 11; i += 1) await t.post(WEBAPP, { initData: busy }, t.csrfHeaders, ip);
    expect((await t.post(WEBAPP, { initData: busy }, t.csrfHeaders, ip)).statusCode).toBe(429);

    const other = t.initDataFor(track(t.newTelegramId()));
    expect((await t.post(WEBAPP, { initData: other }, t.csrfHeaders, ip)).statusCode).toBe(200);
  });

  it('the window starts at the first hit and the key always has a TTL (never stuck)', async () => {
    const telegramId = track(t.newTelegramId());
    await t.post(WEBAPP, { initData: t.initDataFor(telegramId) }, t.csrfHeaders);
    const redis = t.app().get(RedisService).client;
    const ttl = await redis.ttl(webappLimitKey(telegramId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('forged initData never touches the account counter', async () => {
    const victim = track(t.newTelegramId());
    const real = t.initDataFor(victim);
    const forged = real.replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`);
    expect(forged).not.toBe(real);
    for (let i = 0; i < 15; i += 1) {
      const res = await t.post(WEBAPP, { initData: forged }, t.csrfHeaders, t.nextIp());
      expect(res.statusCode).toBe(401);
    }
    expect(await t.app().get(RedisService).client.exists(webappLimitKey(victim))).toBe(0);
    expect((await t.post(WEBAPP, { initData: real }, t.csrfHeaders, t.nextIp())).statusCode).toBe(
      200,
    );
  });

  it('per IP it is only a flood cap: 120 calls pass, the 121st -> 429', async () => {
    const ip = t.nextIp();
    const forged = t.initDataFor(1).replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`);
    const codes: number[] = [];
    for (let i = 0; i < 121; i += 1) {
      codes.push((await t.post(WEBAPP, { initData: forged }, t.csrfHeaders, ip)).statusCode);
    }
    expect(codes.slice(0, 120).every((c) => c === 401)).toBe(true);
    expect(codes[120]).toBe(429);
  });
});

describe('CSRF on a public POST (login CSRF), real Postgres', () => {
  const t = useAuthE2e();

  it('no X-CSRF-Token -> 404; foreign Origin -> 404; no Origin -> 404; nothing is created', async () => {
    const telegramId = t.newTelegramId();
    const payload = { initData: t.initDataFor(telegramId) };
    const origin = t.env.WEB_URL;

    const noToken = await t.post(WEBAPP, payload, { origin });
    const foreign = await t.post(WEBAPP, payload, {
      'x-csrf-token': '1',
      origin: 'https://evil.example',
    });
    const noOrigin = await t.post(WEBAPP, payload, { 'x-csrf-token': '1' });
    for (const res of [noToken, foreign, noOrigin]) {
      expect(res.statusCode).toBe(404);
      expect(body(res).error?.code).toBe('NOT_FOUND');
    }
    expect(await t.db.user.count({ where: { telegramId: BigInt(telegramId) } })).toBe(0);

    const ok = await t.post(WEBAPP, payload, t.csrfHeaders);
    expect(ok.statusCode).toBe(200);
  });
});
