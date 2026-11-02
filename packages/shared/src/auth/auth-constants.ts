// Auth timings and names shared by api (issue/verify) and, later, web/admin clients. Seconds
// everywhere, so no unit confusion with the ms-based BullMQ/Date code.

/**
 * Web access token (cookie `access_token`). Short on purpose: it carries the session family id
 * (`sid`) and is only honoured while that family is active, which costs one indexed lookup per
 * request; the short life bounds the damage if that lookup is ever skipped.
 */
export const ACCESS_TOKEN_TTL_SEC = 900;

/** Web refresh token (cookie `refresh_token`), sliding: reset at every rotation (Q12). */
export const REFRESH_TOKEN_TTL_SEC = 2_592_000;

/** Mini App bearer token (`expiresIn` in the /auth/telegram/webapp response). */
export const MINI_APP_TOKEN_TTL_SEC = 3600;

/** A sent OTP code is valid for 3 minutes (.claude/rules/60-security.md). */
export const OTP_CODE_TTL_SEC = 180;

/** A login nonce waits this long in PENDING for the user to open the bot (Q4). */
export const LOGIN_NONCE_TTL_SEC = 600;

/**
 * Wrong-code attempts per login request. Mirrored by a DB CHECK (`attempts BETWEEN 0 AND 5`)
 * in migration 20261102105448_auth_bot_guardrails: change both together.
 */
export const OTP_MAX_ATTEMPTS = 5;

export const OTP_LENGTH = 6;

/**
 * Bot-side abuse limit: login codes the bot sends to one Telegram account per window. A script
 * that owns an account could otherwise open unlimited login links, each costing a Telegram
 * message and a database row; it also caps how many fresh codes land on a victim who was
 * talked into opening links. A code that was never delivered is released and stops counting.
 */
export const BOT_CODE_ISSUE_LIMIT = { max: 5, windowSec: 600 } as const;

export const ACCESS_COOKIE_NAME = 'access_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** The refresh cookie is only sent to the auth routes, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Custom header required on cookie-authenticated writes: a cross-site form cannot set it. */
export const CSRF_HEADER = 'x-csrf-token';

/** Prefix of the bot callback that ends a web session from the "new sign-in" notice. */
export const SESSION_END_CALLBACK_PREFIX = 'se:';

/** Telegram allows 64 bytes of callback_data; a UUID family id plus the prefix is 39. */
export function sessionEndCallbackData(familyId: string): string {
  const data = `${SESSION_END_CALLBACK_PREFIX}${familyId}`;
  if (data.length > 64) throw new Error('session-end callback_data exceeds 64 bytes');
  return data;
}
