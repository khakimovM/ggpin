import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { QUEUES, authCookieNames } from '@repo/shared';
import type { Queue } from 'bullmq';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import type { Env } from '../../../config/env';
import { TestDatabasePrismaService } from '../../../infra/prisma/__tests__/test-database-prisma.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { UsersService } from '../../users/users.service';
import { newLoginJobId } from '../new-login-notice.service';
import { OtpLoginService } from '../otp-login.service';

// Cookie names and attributes per NODE_ENV, end to end (Q13). The shared harness (auth-e2e.helpers)
// is fixed to the test environment, so this suite boots its own apps: the env object is passed
// straight to AppModule (not re-parsed), which lets NODE_ENV=production run on the test database.
const BASE = '/api/v1/auth';
const SILENT = { write: (): void => undefined };

type Res = Awaited<ReturnType<NestFastifyApplication['inject']>>;
const cookiesOf = (res: Res): string[] => {
  const raw = res.headers['set-cookie'];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
};
const lineOf = (res: Res, name: string): string =>
  cookiesOf(res).find((c) => c.startsWith(`${name}=`)) ?? '';
const attrsOf = (line: string): string[] => line.split('; ').slice(1).sort();
const valueOf = (res: Res, name: string): string =>
  lineOf(res, name)
    .slice(name.length + 1)
    .split(';')[0] ?? '';

interface Session {
  readonly access: string;
  readonly refresh: string;
  readonly verified: Res;
}

function useApp(nodeEnv: 'production' | 'development') {
  const env: Env = { ...buildE2eEnv(), NODE_ENV: nodeEnv };
  const names = authCookieNames(nodeEnv);
  const telegramIds = new Set<bigint>();
  let app: NestFastifyApplication;
  let db: PrismaService['client'];
  let ipSeq = 0;

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [AppModule.register(env, { logDestination: SILENT })],
    });
    // A production config on the *_test database: skip only the production database identity
    // check (D-52 r2), as the quotes production suite does.
    if (nodeEnv === 'production') {
      builder.overrideProvider(PrismaService).useClass(TestDatabasePrismaService);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(PrismaService).client;
  });

  afterAll(async () => {
    const users = await db.user.findMany({
      where: { telegramId: { in: [...telegramIds] } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    const queue = app.get<Queue>(getQueueToken(QUEUES.TG_OUTBOX));
    const families = await db.webSession.findMany({
      where: { userId: { in: ids } },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    for (const { familyId } of families) await queue.remove(newLoginJobId(familyId));
    await db.loginRequest.deleteMany({ where: { telegramId: { in: [...telegramIds] } } });
    await db.webSession.deleteMany({ where: { userId: { in: ids } } });
    await db.user.updateMany({ where: { id: { in: ids } }, data: { referredById: null } });
    await db.wallet.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  // A unique client address per request keeps every call in its own per-IP throttle bucket.
  const ip = (): string => {
    ipSeq += 1;
    return `10.77.${String(Math.floor(ipSeq / 255) % 256)}.${String((ipSeq % 255) + 1)}`;
  };
  const csrf = { 'x-csrf-token': 'e2e', origin: env.WEB_URL };
  const post = (url: string, payload: object, headers: Record<string, string> = {}): Promise<Res> =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { ...csrf, ...headers },
      remoteAddress: ip(),
    });
  const get = (url: string, cookie: string): Promise<Res> =>
    app.inject({ method: 'GET', url, headers: { cookie }, remoteAddress: ip() });

  async function login(): Promise<Session> {
    const now = new Date();
    const telegramId = BigInt(Date.now() * 4000 + (randomBytes(2).readUInt16BE() % 4000));
    telegramIds.add(telegramId);
    await app.get(UsersService).ensureTelegramUser({ telegramId, firstName: 'Cookie' }, { now });
    const { nonce } = await app.get(OtpLoginService).start(now);
    const issued = await app.get(OtpLoginService).issueCode({ nonce, telegramId, now });
    if (!issued.ok) throw new Error(`issueCode refused: ${issued.reason}`);
    const verified = await post(`${BASE}/telegram/verify`, { nonce, code: issued.code });
    if (verified.statusCode !== 200) throw new Error(`verify failed: ${verified.statusCode}`);
    return {
      access: valueOf(verified, names.access),
      refresh: valueOf(verified, names.refresh),
      verified,
    };
  }
  return { names, login, post, get };
}

describe('production: __Host- cookie names (real Postgres)', () => {
  const t = useApp('production');
  const ME = '/api/v1/me';

  it('verify sets exactly the two prefixed cookies with the attributes the prefixes demand', async () => {
    const { verified, access, refresh } = await t.login();
    const cookies = cookiesOf(verified);
    expect(cookies).toHaveLength(2);
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual([
      '__Host-access_token',
      '__Host-refresh_token',
    ]);
    expect(access).not.toBe('');
    expect(refresh).not.toBe('');

    const host = attrsOf(lineOf(verified, '__Host-access_token'));
    expect(host).toEqual(expect.arrayContaining(['HttpOnly', 'Path=/', 'SameSite=Lax', 'Secure']));
    expect(host.some((a) => a.toLowerCase().startsWith('domain'))).toBe(false);

    const refreshAttrs = attrsOf(lineOf(verified, '__Host-refresh_token'));
    expect(refreshAttrs).toEqual(
      expect.arrayContaining(['HttpOnly', 'Path=/', 'SameSite=Lax', 'Secure']),
    );
    expect(refreshAttrs.some((a) => a.toLowerCase().startsWith('domain'))).toBe(false);
  });

  it('a request with the prefixed access cookie is accepted; the old name is not', async () => {
    const { access } = await t.login();
    expect((await t.get(ME, `__Host-access_token=${access}`)).statusCode).toBe(200);
    expect((await t.get(ME, `access_token=${access}`)).statusCode).toBe(401);
  });

  it('refresh reads the prefixed cookie, rotates under the same names and ignores the old name', async () => {
    const { access, refresh } = await t.login();
    const legacy = await t.post(`${BASE}/refresh`, {}, { cookie: `refresh_token=${refresh}` });
    expect(legacy.statusCode).toBe(401);
    // The failed attempt clears the prefixed pair, so a browser holding them drops them.
    for (const [name, path] of [
      ['__Host-access_token', '/'],
      ['__Host-refresh_token', '/'],
    ] as const) {
      const line = lineOf(legacy, name);
      expect(line.startsWith(`${name}=;`)).toBe(true);
      expect(line).toContain('Max-Age=0');
      expect(line).toContain(`Path=${path}`);
    }

    // The refused attempt did not touch the session: the real refresh cookie still works.
    const ok = await t.post(`${BASE}/refresh`, {}, { cookie: `__Host-refresh_token=${refresh}` });
    expect(ok.statusCode).toBe(200);
    const next = valueOf(ok, '__Host-refresh_token');
    expect(next).not.toBe('');
    expect(next).not.toBe(refresh);
    expect(
      (await t.get(ME, `__Host-access_token=${valueOf(ok, '__Host-access_token')}`)).statusCode,
    ).toBe(200);
    expect(access).not.toBe('');
  });

  it('sessions list and logout work with the prefixed names; logout clears them', async () => {
    const { access, refresh } = await t.login();
    const cookie = `__Host-access_token=${access}; __Host-refresh_token=${refresh}`;
    const list = await t.get(`${BASE}/sessions`, cookie);
    expect(list.statusCode).toBe(200);

    const out = await t.post(`${BASE}/logout`, {}, { cookie });
    expect(out.statusCode).toBe(200);
    for (const name of ['__Host-access_token', '__Host-refresh_token']) {
      expect(lineOf(out, name)).toContain('Max-Age=0');
    }
    expect(cookiesOf(out).some((c) => /^(access|refresh)_token=/.test(c))).toBe(false);
    // The family is revoked: the access token is dead before its 15 minutes run out.
    expect((await t.get(ME, `__Host-access_token=${access}`)).statusCode).toBe(401);
  });
});

// With `__Secure-` a sibling subdomain could plant a twin refresh cookie (Domain=..., longer Path);
// `__Host-` makes the browser refuse that, so a repeated name should never arrive. If it does
// anyway (a browser bug, a dev name), the parser keeps only the first value and the request
// cannot be attributed: the second line below.
describe('production: repeated auth cookie names are refused (S3B-L1)', () => {
  const t = useApp('production');
  const ME = '/api/v1/me';
  const REFRESH = `${BASE}/refresh`;
  const twin = (planted: string, own: string): string =>
    `__Host-refresh_token=${planted}; __Host-refresh_token=${own}`;

  it('two refresh cookies -> 401, nothing rotated or revoked, our cookies cleared', async () => {
    const victim = await t.login();
    const attacker = await t.login();
    const res = await t.post(REFRESH, {}, { cookie: twin(attacker.refresh, victim.refresh) });
    expect(res.statusCode).toBe(401);
    for (const name of ['__Host-access_token', '__Host-refresh_token']) {
      expect(lineOf(res, name)).toContain('Max-Age=0');
    }
    // Neither family was rotated (a rotated token would now be a reuse and kill its family).
    for (const { refresh } of [victim, attacker]) {
      const ok = await t.post(REFRESH, {}, { cookie: `__Host-refresh_token=${refresh}` });
      expect(ok.statusCode).toBe(200);
    }
  });

  it('logout with two refresh cookies ends both sessions and clears the cookies', async () => {
    const first = await t.login();
    const second = await t.login();
    const out = await t.post(`${BASE}/logout`, {}, { cookie: twin(first.refresh, second.refresh) });
    expect(out.statusCode).toBe(200);
    expect(lineOf(out, '__Host-refresh_token')).toContain('Max-Age=0');
    for (const { refresh } of [first, second]) {
      const res = await t.post(REFRESH, {}, { cookie: `__Host-refresh_token=${refresh}` });
      expect(res.statusCode).toBe(401);
    }
    expect((await t.get(ME, `__Host-access_token=${first.access}`)).statusCode).toBe(401);
  });

  it('two access cookies -> 401 even when both are valid; one still works', async () => {
    const a = await t.login();
    const b = await t.login();
    const both = `__Host-access_token=${a.access}; __Host-access_token=${b.access}`;
    expect((await t.get(ME, both)).statusCode).toBe(401);
    expect((await t.get(ME, `__Host-access_token=${a.access}`)).statusCode).toBe(200);
  });
});

describe('development: plain names, no Secure', () => {
  const t = useApp('development');

  it('verify sets access_token / refresh_token; requests with them work, __Host- is ignored', async () => {
    const { verified, access } = await t.login();
    expect(
      cookiesOf(verified)
        .map((c) => c.split('=')[0])
        .sort(),
    ).toEqual(['access_token', 'refresh_token']);
    expect(attrsOf(lineOf(verified, 'access_token'))).not.toContain('Secure');
    expect(attrsOf(lineOf(verified, 'refresh_token'))).toEqual(
      expect.arrayContaining(['HttpOnly', 'Path=/', 'SameSite=Lax']),
    );
    expect((await t.get('/api/v1/me', `access_token=${access}`)).statusCode).toBe(200);
    expect((await t.get('/api/v1/me', `__Host-access_token=${access}`)).statusCode).toBe(401);
  });
});
