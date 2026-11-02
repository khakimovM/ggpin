// Auth timings and names shared by api (issue/verify) and, later, web/admin clients. Seconds
// everywhere, so no unit confusion with the ms-based BullMQ/Date code.

/** Web access token (cookie `access_token`). Short: it is checked without a DB round trip. */
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
 * added in slice S2: change both together.
 */
export const OTP_MAX_ATTEMPTS = 5;

export const OTP_LENGTH = 6;

/**
 * Bot-side abuse limit: codes issued per Telegram account per window. Without it anyone could
 * make the bot message a stranger's account with codes by opening login links in their name.
 */
export const BOT_CODE_ISSUE_LIMIT = { max: 5, windowSec: 600 } as const;

export const ACCESS_COOKIE_NAME = 'access_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** The refresh cookie is only sent to the auth routes, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Custom header required on cookie-authenticated writes: a cross-site form cannot set it. */
export const CSRF_HEADER = 'x-csrf-token';
