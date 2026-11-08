import type { User } from '@repo/db';
import { ACCESS_COOKIE_NAME, authCookieNames } from '@repo/shared';
import { TokenCodec, type TokenPayload } from '../../../modules/auth/token-codec';
import type { WebSessionService } from '../../../modules/auth/web-session.service';
import type { UsersService } from '../../../modules/users/users.service';
import { AppError } from '../../exceptions/app-error';
import { IS_PUBLIC_KEY } from '../public.decorator';
import { UserAuthGuard } from '../user-auth.guard';
import { fakeContext, fakeRequest, type FakeRequestInit } from './guard-context';

const fake = (...parts: string[]): string => parts.join('');
const codec = new TokenCodec({
  JWT_ACCESS_SECRET: fake('web-secret-', 'a'.repeat(24)),
  TG_SESSION_SECRET: fake('tg-secret-', 'b'.repeat(24)),
});

const now = new Date('2026-06-01T12:00:00.000Z');
const nowSec = Math.floor(now.getTime() / 1000);
const tgToken = (over: Partial<TokenPayload> = {}): string =>
  codec.sign({ typ: 'tg', sub: 'u1', iat: nowSec, exp: nowSec + 3600, ...over });
const webToken = (over: Partial<TokenPayload> = {}): string =>
  codec.sign({ typ: 'web', sub: 'u1', sid: 'fam1', iat: nowSec, exp: nowSec + 900, ...over });

const userRow = (over: Partial<User> = {}): User =>
  ({ id: 'u1', telegramId: 555n, isBlocked: false, ...over }) as User;

function setup(
  opts: { user?: User | null; familyActive?: boolean; nodeEnv?: 'production' | 'test' } = {},
) {
  const findById = jest.fn().mockResolvedValue(opts.user === undefined ? userRow() : opts.user);
  const isFamilyActive = jest.fn().mockResolvedValue(opts.familyActive ?? true);
  const run = (init: FakeRequestInit, metadata: Record<string, unknown> = {}) => {
    const request = fakeRequest(init);
    const { context, reflector } = fakeContext(request, metadata);
    const guard = new UserAuthGuard(
      reflector,
      codec,
      { findById } as unknown as UsersService,
      { isFamilyActive } as unknown as WebSessionService,
      { now: () => now },
      { NODE_ENV: opts.nodeEnv ?? 'test' },
    );
    return { request, result: guard.canActivate(context) };
  };
  return { run, findById, isFamilyActive };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('UserAuthGuard', () => {
  it('skips @Public() routes without touching tokens or the database', async () => {
    const { run, findById } = setup();
    const { request, result } = run({}, { [IS_PUBLIC_KEY]: true });
    await expect(result).resolves.toBe(true);
    expect(request.authUser).toBeUndefined();
    expect(findById).not.toHaveBeenCalled();
  });

  it('Bearer tg token -> attaches { id, telegramId, channel: tg }', async () => {
    const { run, isFamilyActive } = setup();
    const { request, result } = run({ headers: { authorization: `Bearer ${tgToken()}` } });
    await expect(result).resolves.toBe(true);
    expect(request.authUser).toEqual({ id: 'u1', telegramId: 555n, channel: 'tg' });
    expect(isFamilyActive).not.toHaveBeenCalled(); // Mini App tokens are stateless
  });

  it('cookie web token + active family -> channel web with sessionFamilyId', async () => {
    const { run, isFamilyActive } = setup();
    const { request, result } = run({ cookies: { [ACCESS_COOKIE_NAME]: webToken() } });
    await expect(result).resolves.toBe(true);
    expect(request.authUser).toEqual({
      id: 'u1',
      telegramId: 555n,
      channel: 'web',
      sessionFamilyId: 'fam1',
    });
    expect(isFamilyActive).toHaveBeenCalledWith({ familyId: 'fam1', userId: 'u1' }, now);
  });

  it('production reads only the __Host- cookie; the plain name is not accepted', async () => {
    const { run } = setup({ nodeEnv: 'production' });
    const prefixed = authCookieNames('production').access;
    expect(prefixed).toBe('__Host-access_token');
    const ok = run({ cookies: { [prefixed]: webToken() } });
    await expect(ok.result).resolves.toBe(true);
    expect(ok.request.authUser?.channel).toBe('web');

    const legacy = run({ cookies: { [ACCESS_COOKIE_NAME]: webToken() } });
    await expect(codeOf(legacy.result)).resolves.toBe('UNAUTHORIZED');
  });

  it('a repeated access cookie name -> UNAUTHORIZED even if both values are valid', async () => {
    const { run, findById } = setup({ nodeEnv: 'production' });
    const name = '__Host-access_token';
    const token = webToken();
    const { result } = run({
      headers: { cookie: `${name}=${token}; ${name}=${token}` },
      cookies: { [name]: token },
    });
    await expect(codeOf(result)).resolves.toBe('UNAUTHORIZED');
    expect(findById).not.toHaveBeenCalled();
  });

  it('one access cookie in the raw header is accepted; a Bearer token ignores the cookie check', async () => {
    const { run } = setup();
    const token = webToken();
    const one = run({
      headers: { cookie: `${ACCESS_COOKIE_NAME}=${token}` },
      cookies: { [ACCESS_COOKIE_NAME]: token },
    });
    await expect(one.result).resolves.toBe(true);

    const bearer = run({
      headers: {
        authorization: `Bearer ${tgToken()}`,
        cookie: `${ACCESS_COOKIE_NAME}=a; ${ACCESS_COOKIE_NAME}=b`,
      },
    });
    await expect(bearer.result).resolves.toBe(true);
  });

  it('outside production the __Host- cookie is ignored', async () => {
    const { run } = setup();
    const { result } = run({ cookies: { '__Host-access_token': webToken() } });
    await expect(codeOf(result)).resolves.toBe('UNAUTHORIZED');
  });

  it('web token whose family is revoked/expired -> UNAUTHORIZED, user never loaded', async () => {
    const { run, findById } = setup({ familyActive: false });
    const { result } = run({ cookies: { [ACCESS_COOKIE_NAME]: webToken() } });
    await expect(codeOf(result)).resolves.toBe('UNAUTHORIZED');
    expect(findById).not.toHaveBeenCalled();
  });

  it('web token without sid -> UNAUTHORIZED', async () => {
    const { run } = setup();
    const { sid: _sid, ...noSid } = {
      typ: 'web' as const,
      sub: 'u1',
      sid: 'x',
      iat: nowSec,
      exp: nowSec + 900,
    };
    const token = codec.sign(noSid);
    await expect(codeOf(run({ cookies: { [ACCESS_COOKIE_NAME]: token } }).result)).resolves.toBe(
      'UNAUTHORIZED',
    );
  });

  it.each([
    ['no credentials', {}],
    ['garbage bearer', { headers: { authorization: 'Bearer nope' } }],
    ['empty bearer', { headers: { authorization: 'Bearer ' } }],
    ['expired tg token', { headers: { authorization: `Bearer ${tgToken({ exp: nowSec })}` } }],
    ['a web token as Bearer', { headers: { authorization: `Bearer ${webToken()}` } }],
    ['a tg token as the access cookie', { cookies: { [ACCESS_COOKIE_NAME]: tgToken() } }],
    ['expired web cookie', { cookies: { [ACCESS_COOKIE_NAME]: webToken({ exp: nowSec }) } }],
    ['empty cookie', { cookies: { [ACCESS_COOKIE_NAME]: '' } }],
  ] as [string, FakeRequestInit][])(
    '%s -> UNAUTHORIZED (throws, never returns false)',
    async (_n, init) => {
      const { run } = setup();
      await expect(codeOf(run(init).result)).resolves.toBe('UNAUTHORIZED');
    },
  );

  it('a bad Bearer does not fall back to a valid cookie', async () => {
    const { run } = setup();
    const { result } = run({
      headers: { authorization: 'Bearer nope' },
      cookies: { [ACCESS_COOKIE_NAME]: webToken() },
    });
    await expect(codeOf(result)).resolves.toBe('UNAUTHORIZED');
  });

  it('a non-Bearer Authorization scheme is ignored and the cookie is used', async () => {
    const { run } = setup();
    const { request, result } = run({
      headers: { authorization: 'Basic dXNlcjpwdw==' },
      cookies: { [ACCESS_COOKIE_NAME]: webToken() },
    });
    await expect(result).resolves.toBe(true);
    expect(request.authUser?.channel).toBe('web');
  });

  it('valid token for a deleted user -> UNAUTHORIZED', async () => {
    const { run } = setup({ user: null });
    const { result } = run({ headers: { authorization: `Bearer ${tgToken()}` } });
    await expect(codeOf(result)).resolves.toBe('UNAUTHORIZED');
  });

  it('blocked user -> USER_BLOCKED (403), on both channels', async () => {
    const { run } = setup({ user: userRow({ isBlocked: true }) });
    await expect(
      codeOf(run({ headers: { authorization: `Bearer ${tgToken()}` } }).result),
    ).resolves.toBe('USER_BLOCKED');
    await expect(
      codeOf(run({ cookies: { [ACCESS_COOKIE_NAME]: webToken() } }).result),
    ).resolves.toBe('USER_BLOCKED');
  });
});
