import { ERROR_HTTP_STATUS, errorMessageKey, type ErrorCode } from '@repo/shared';

/**
 * What an AppError may add to the response besides the envelope. Deliberately not a free-form
 * header map: a thrower must never be able to set Set-Cookie, Location or CORS headers, or pass
 * a value with CR/LF in it.
 */
export interface AppErrorOptions {
  /** Seconds until the caller may retry (RATE_LIMITED); sent as Retry-After. */
  readonly retryAfterSec?: number;
}

// The longest wait we ever ask for. A bigger or non-numeric input must still yield a valid
// RFC 9110 delay-seconds (String(1e21) would be "1e+21").
const MAX_RETRY_AFTER_SEC = 86_400;

function retryAfterSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.ceil(value), MAX_RETRY_AFTER_SEC);
}

// The one exception services throw for a business failure. The HTTP status is derived from
// the contract table (ERROR_HTTP_STATUS) so a code can never be paired with a different
// status, and `message` is the i18n key so even an accidental log line holds no prose.
// `details` may contain BigInt (e.g. INSUFFICIENT_BALANCE balances); the exception filter
// converts them to strings before they reach the wire.
export class AppError extends Error {
  readonly status: number;
  /** Response headers the exception filter sets; built here from AppErrorOptions only. */
  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    readonly code: ErrorCode,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: AppErrorOptions,
  ) {
    super(errorMessageKey(code));
    this.name = 'AppError';
    this.status = ERROR_HTTP_STATUS[code];
    if (options?.retryAfterSec !== undefined) {
      this.headers = { 'Retry-After': String(retryAfterSeconds(options.retryAfterSec)) };
    }
  }
}
