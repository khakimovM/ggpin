import { isApiError } from '../../lib/api/errors';
import type { LoginProblem } from './login-machine';

/** Seconds to wait when a 429 carries no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_SEC = 60;

/** Reduces whatever a login request threw to the few cases the screen tells apart. */
export function problemOf(error: unknown, now: number = Date.now()): LoginProblem {
  if (!isApiError(error)) return { kind: 'generic' };
  switch (error.code) {
    case 'RATE_LIMITED':
      return {
        kind: 'rateLimited',
        until: now + (error.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC) * 1000,
      };
    case 'USER_BLOCKED':
      return { kind: 'blocked' };
    case 'NETWORK':
      return { kind: 'network' };
    default:
      return { kind: 'generic' };
  }
}

/**
 * Whether the bot link the API returned points at OUR bot. The link is shown to the user as "open
 * Telegram", so a start answer naming another bot (a misconfigured or hijacked API) must not be
 * offered. Telegram usernames are case-insensitive.
 */
export function botUrlIsOurs(botUrl: string, botUsername: string): boolean {
  try {
    const url = new URL(botUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname === 't.me' &&
      url.pathname.slice(1).toLowerCase() === botUsername.toLowerCase()
    );
  } catch {
    return false;
  }
}
