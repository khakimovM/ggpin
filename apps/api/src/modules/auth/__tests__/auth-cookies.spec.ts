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

  it('access cookie: Path /, 15 min; refresh cookie: auth path only, 30 days', () => {
    const [access, refresh] = sessionCookieSpecs(TOKENS, true);
    expect(access).toEqual({
      name: ACCESS_COOKIE_NAME,
      value: 'access-value',
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SEC,
      secure: true,
    });
    expect(refresh).toEqual({
      name: REFRESH_COOKIE_NAME,
      value: 'refresh-value',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_SEC,
      secure: true,
    });
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
    const set = sessionCookieSpecs(TOKENS, true);
    const cleared = clearCookieSpecs(true);
    expect(cleared.map((c) => [c.name, c.path])).toEqual(set.map((c) => [c.name, c.path]));
    for (const c of cleared) {
      expect(c.maxAge).toBe(0);
      expect(c.value).toBe('');
    }

    const { reply, calls } = recorder();
    clearSessionCookies(reply, 'production');
    expect(calls.map((c) => c.options.maxAge)).toEqual([0, 0]);
    expect(calls.map((c) => c.options.path)).toEqual(['/', REFRESH_COOKIE_PATH]);
    expect(calls.every((c) => c.options.expires?.getTime() === 0)).toBe(true);
  });
});
