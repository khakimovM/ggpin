import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SEC,
} from '@repo/shared';
import {
  clearSessionCookies,
  clearCookieSpecs,
  enforcePrefixRules,
  isSecureCookie,
  sessionCookieSpecs,
  setSessionCookies,
  type CookieReply,
} from '../auth-cookies';

const TOKENS = { accessToken: 'access-value', refreshToken: 'refresh-value' };

interface Call {
  name: string;
  value: string;
  options: Parameters<CookieReply['setCookie']>[2];
}

function recorder(): { reply: CookieReply; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    reply: {
      setCookie: (name, value, options) => {
        calls.push({ name, value, options });
      },
    },
  };
}

describe('auth cookies', () => {
  it('Secure everywhere except development', () => {
    expect(isSecureCookie('development')).toBe(false);
    expect(isSecureCookie('production')).toBe(true);
    expect(isSecureCookie('test')).toBe(true);
  });

  it('access cookie: Path /, 15 min; refresh cookie: Path /, 30 days', () => {
    const [access, refresh] = sessionCookieSpecs(TOKENS, 'production');
    expect(access).toEqual({
      name: '__Host-access_token',
      value: 'access-value',
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SEC,
      secure: true,
    });
    expect(refresh).toEqual({
      name: '__Host-refresh_token',
      value: 'refresh-value',
      path: '/',
      maxAge: REFRESH_TOKEN_TTL_SEC,
      secure: true,
    });
  });

  it.each(['development', 'test'] as const)('%s: plain names, same paths', (nodeEnv) => {
    const [access, refresh] = sessionCookieSpecs(TOKENS, nodeEnv);
    expect([access?.name, access?.path]).toEqual([ACCESS_COOKIE_NAME, '/']);
    expect([refresh?.name, refresh?.path]).toEqual([REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH]);
  });

  it('production: both cookies are __Host-, Secure, Path=/ and never carry a Domain', () => {
    const { reply, calls } = recorder();
    setSessionCookies(reply, TOKENS, 'production');
    expect(calls.map((c) => c.name)).toEqual(['__Host-access_token', '__Host-refresh_token']);
    for (const call of calls) {
      expect(call.options).toMatchObject({ secure: true, path: '/' });
      expect(call.options).not.toHaveProperty('domain');
    }
  });

  it.each([
    ['production', true],
    ['development', false],
  ] as const)('%s: HttpOnly, SameSite=Lax, no Domain, Secure=%s', (nodeEnv, secure) => {
    const { reply, calls } = recorder();
    setSessionCookies(reply, TOKENS, nodeEnv);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure });
      expect(call.options).not.toHaveProperty('domain');
    }
  });

  it('clearing repeats the same names and paths with Max-Age 0 and an empty value', () => {
    const set = sessionCookieSpecs(TOKENS, 'production');
    const cleared = clearCookieSpecs('production');
    expect(cleared.map((c) => [c.name, c.path])).toEqual(set.map((c) => [c.name, c.path]));
    for (const c of cleared) {
      expect(c.maxAge).toBe(0);
      expect(c.value).toBe('');
    }

    const { reply, calls } = recorder();
    clearSessionCookies(reply, 'production');
    expect(calls.map((c) => c.name)).toEqual(['__Host-access_token', '__Host-refresh_token']);
    expect(calls.map((c) => c.options.maxAge)).toEqual([0, 0]);
    expect(calls.map((c) => c.options.path)).toEqual(['/', '/']);
    expect(calls.every((c) => c.options.expires?.getTime() === 0)).toBe(true);
  });

  it('a non-dev NODE_ENV outside the known list is fail-closed: prefixed and Secure', () => {
    const staging = 'staging' as unknown as Parameters<typeof sessionCookieSpecs>[1];
    const specs = sessionCookieSpecs(TOKENS, staging);
    expect(specs.map((c) => c.name)).toEqual(['__Host-access_token', '__Host-refresh_token']);
    expect(specs.every((c) => c.secure)).toBe(true);
  });

  describe('enforcePrefixRules', () => {
    const spec = { name: 'x', value: 'v', path: '/', maxAge: 1, secure: false };

    it('forces Secure on both prefixes', () => {
      expect(enforcePrefixRules({ ...spec, name: '__Host-a' }).secure).toBe(true);
      expect(enforcePrefixRules({ ...spec, name: '__Secure-a', path: '/p' }).secure).toBe(true);
    });

    it('refuses a __Host- cookie on a path other than /', () => {
      expect(() => enforcePrefixRules({ ...spec, name: '__Host-a', path: '/api' })).toThrow(
        'must use Path=/',
      );
    });

    it('leaves unprefixed cookies alone (development stays non-Secure)', () => {
      const plain = { ...spec, name: 'access_token' };
      expect(enforcePrefixRules(plain)).toBe(plain);
      expect(plain.secure).toBe(false);
    });
  });
});
