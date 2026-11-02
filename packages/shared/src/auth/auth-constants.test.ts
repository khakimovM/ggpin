import { describe, expect, it } from 'vitest';
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SEC,
  BOT_CODE_ISSUE_LIMIT,
  CSRF_HEADER,
  LOGIN_NONCE_TTL_SEC,
  MINI_APP_TOKEN_TTL_SEC,
  OTP_CODE_TTL_SEC,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SEC,
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
    expect(REFRESH_COOKIE_PATH).toBe('/api/v1/auth');
    expect(CSRF_HEADER).toBe('x-csrf-token');
  });
});
