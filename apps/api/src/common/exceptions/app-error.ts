import { ERROR_HTTP_STATUS, errorMessageKey, type ErrorCode } from '@repo/shared';

// The one exception services throw for a business failure. The HTTP status is derived from
// the contract table (ERROR_HTTP_STATUS) so a code can never be paired with a different
// status, and `message` is the i18n key so even an accidental log line holds no prose.
// `details` may contain BigInt (e.g. INSUFFICIENT_BALANCE balances); the exception filter
// converts them to strings before they reach the wire.
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(errorMessageKey(code));
    this.name = 'AppError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}
