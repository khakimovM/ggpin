import { ACCESS_COOKIE_NAME, meSchema } from '@repo/shared';
import { UsersService } from '../../users/users.service';
import { useAuthE2e, type AuthE2e } from './auth-e2e.helpers';

const ME = '/api/v1/me';

type Body = { success: boolean; data?: Record<string, unknown>; error?: { code: string } };
type Res = Awaited<ReturnType<AuthE2e['get']>>;
const body = (res: Res): Body => res.json<Body>();

describe('web cookie session through the same guard (real Postgres)', () => {
  const t = useAuthE2e();
  let userId = '';
  let familyId = '';
  let cookie = '';

  async function newSession(over: { expiresAt?: Date; revokedAt?: Date; userId?: string } = {}) {
    const family = `fam_${String(t.newTelegramId())}`;
    await t.db.webSession.create({
      data: {
        userId: over.userId ?? userId,
        familyId: family,
        refreshHash: `rh_${family}_${String(Math.random())}`,
        expiresAt: over.expiresAt ?? new Date(t.clock.now().getTime() + 86_400_000),
        revokedAt: over.revokedAt ?? null,
      },
    });
    return family;
  }
  function cookieFor(sub: string, sid: string, ttlSec = 900): string {
    const nowSec = Math.floor(t.clock.now().getTime() / 1000);
    const token = t.codec.sign({ typ: 'web', sub, sid, iat: nowSec, exp: nowSec + ttlSec });
    return `${ACCESS_COOKIE_NAME}=${token}`;
  }

  beforeAll(async () => {
    const telegramId = t.newTelegramId();
    const user = await t
      .app()
      .get(UsersService)
      .ensureTelegramUser(
        { telegramId: BigInt(telegramId), firstName: 'Web' },
        { now: t.clock.now() },
      );
    userId = user.user.id;
    familyId = await newSession();
    cookie = cookieFor(userId, familyId);
  });

  it('cookie + live family -> GET /me 200', async () => {
    const res = await t.get(ME, { cookie });
    expect(res.statusCode).toBe(200);
    expect(meSchema.parse(body(res).data).id).toBe(userId);
  });

  it('PATCH /me by cookie without X-CSRF-Token -> 404 NOT_FOUND (D-26); locale unchanged', async () => {
    const res = await t.patch(ME, { locale: 'ru' }, { cookie, origin: t.env.WEB_URL });
    expect(res.statusCode).toBe(404);
    expect(body(res).error?.code).toBe('NOT_FOUND');
    const me = await t.get(ME, { cookie });
    expect(meSchema.parse(body(me).data).locale).toBe('uz');
  });

  it('PATCH /me by cookie with a foreign Origin, or none -> 404', async () => {
    const foreign = await t.patch(
      ME,
      { locale: 'ru' },
      { cookie, 'x-csrf-token': '1', origin: 'https://evil.example' },
    );
    expect(foreign.statusCode).toBe(404);
    const none = await t.patch(ME, { locale: 'ru' }, { cookie, 'x-csrf-token': '1' });
    expect(none.statusCode).toBe(404);
  });

  it('PATCH /me by cookie with X-CSRF-Token and an allowed Origin -> 200', async () => {
    const res = await t.patch(ME, { locale: 'ru' }, { cookie, ...t.csrfHeaders });
    expect(res.statusCode).toBe(200);
    expect(meSchema.parse(body(res).data).locale).toBe('ru');
  });

  it('a revoked family kills the still-valid access token at once', async () => {
    const family = await newSession();
    const own = cookieFor(userId, family);
    expect((await t.get(ME, { cookie: own })).statusCode).toBe(200);
    await t.db.webSession.updateMany({
      where: { familyId: family },
      data: { revokedAt: t.clock.now() },
    });
    const res = await t.get(ME, { cookie: own });
    expect(res.statusCode).toBe(401);
    expect(body(res).error?.code).toBe('UNAUTHORIZED');
  });

  it('an expired family -> 401 even though the access token itself is valid', async () => {
    const family = await newSession({ expiresAt: new Date(t.clock.now().getTime() - 1000) });
    expect((await t.get(ME, { cookie: cookieFor(userId, family) })).statusCode).toBe(401);
  });

  it("another user's family id inside my token -> 401 (scoped by userId)", async () => {
    const other = await t
      .app()
      .get(UsersService)
      .ensureTelegramUser(
        { telegramId: BigInt(t.newTelegramId()), firstName: 'Other' },
        { now: t.clock.now() },
      );
    const theirFamily = await newSession({ userId: other.user.id });
    const res = await t.get(ME, { cookie: cookieFor(userId, theirFamily) });
    expect(res.statusCode).toBe(401);
  });

  it('a web token past its own exp -> 401 (clock override)', async () => {
    const short = cookieFor(userId, familyId, 60);
    expect((await t.get(ME, { cookie: short })).statusCode).toBe(200);
    t.clock.advanceSec(61);
    expect((await t.get(ME, { cookie: short })).statusCode).toBe(401);
  });
});
