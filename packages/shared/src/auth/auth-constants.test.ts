import { describe, expect, it } from 'vitest';
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SEC,
  BOT_CODE_ISSUE_LIMIT,
  authCookieNames,
  type AuthNodeEnv,
  CSRF_HEADER,
  LOGIN_NONCE_TTL_SEC,
  MINI_APP_TOKEN_TTL_SEC,
  OTP_CODE_TTL_SEC,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SEC,
  SESSION_END_CALLBACK_PREFIX,
  sessionEndCallbackData,
} from './auth-constants';

// The values are owner decisions (.claude/rules/60-security.md, phase 2 Q4/Q11/Q12); a change
// must be deliberate, so they are pinned here.
describe('auth constants', () => {
  it('pins the approved values', () => {
    expect(ACCESS_TOKEN_TTL_SEC).toBe(15 * 60);
    expect(REFRESH_TOKEN_TTL_SEC).toBe(30 * 24 * 3600);
    expect(MINI_APP_TOKEN_TTL_SEC).toBe(3600);
    expect(OTP_CODE_TTL_SEC).toBe(180);
    expect(LOGIN_NONCE_TTL_SEC).toBe(600);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_LENGTH).toBe(6);
    expect(BOT_CODE_ISSUE_LIMIT).toEqual({ max: 5, windowSec: 600 });
    expect(ACCESS_COOKIE_NAME).toBe('access_token');
    expect(REFRESH_COOKIE_NAME).toBe('refresh_token');
    expect(REFRESH_COOKIE_PATH).toBe('/');
    expect(CSRF_HEADER).toBe('x-csrf-token');
  });
});

describe('sessionEndCallbackData', () => {
  it('prefixes the family id and stays within 64 bytes for a UUID', () => {
    const familyId = '123e4567-e89b-42d3-a456-426614174000';
    const data = sessionEndCallbackData(familyId);
    expect(data).toBe(`${SESSION_END_CALLBACK_PREFIX}${familyId}`);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });

  it('refuses an id that would overflow the callback_data limit', () => {
    expect(() => sessionEndCallbackData('x'.repeat(62))).toThrow(/64 bytes/);
  });
});

describe('authCookieNames', () => {
  it('production: __Host- access and refresh cookies', () => {
    expect(authCookieNames('production')).toEqual({
      access: '__Host-access_token',
      refresh: '__Host-refresh_token',
    });
  });

  it.each(['development', 'test'] as const)('%s keeps the plain names', (env) => {
    expect(authCookieNames(env)).toEqual({ access: 'access_token', refresh: 'refresh_token' });
  });

  it.each(['staging', 'Production', ''])(
    'fail-closed: unknown NODE_ENV "%s" gets the prefixed names',
    (env) => {
      expect(authCookieNames(env as unknown as AuthNodeEnv)).toEqual({
        access: '__Host-access_token',
        refresh: '__Host-refresh_token',
      });
    },
  );

  it('the prefixes are only valid with the attributes the API sets', () => {
    // __Host- forbids a Domain and any Path but "/" (the browser would drop the cookie), and it is
    // what keeps a sibling subdomain from planting a refresh cookie next to ours.
    expect(REFRESH_COOKIE_PATH).toBe('/');
    expect(authCookieNames('production').refresh.startsWith('__Host-')).toBe(true);
  });
});
