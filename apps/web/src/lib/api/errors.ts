import { errorCodeSchema, errorMessageKey, type ErrorCode } from '@repo/shared';
import type { z } from 'zod';

/** Client-only code: the request never got an answer (offline, DNS, CORS, reset connection). */
export const NETWORK_CODE = 'NETWORK' as const;

export type ApiErrorCode = ErrorCode | typeof NETWORK_CODE;

/**
 * i18n key of the text to show. `NETWORK` is not a server code, so it cannot live in the
 * backend-owned `errors.*` namespace; its text is `common.error.network`.
 */
export type ApiErrorMessageKey = `errors.${ErrorCode}` | 'common.error.network';

export function errorKey(code: ApiErrorCode): ApiErrorMessageKey {
  return code === NETWORK_CODE ? 'common.error.network' : errorMessageKey(code);
}

export interface ApiErrorInit {
  /** HTTP status; 0 when no response arrived. */
  status: number;
  code: ApiErrorCode;
  details?: unknown;
  /** Seconds from the `Retry-After` header, when the server sent a valid one. */
  retryAfterSec?: number;
  /**
   * True only when the answer came in OUR error envelope (`{success:false, error:{code}}`), i.e. the
   * API itself said it. A proxy's HTML 404 or 502 is not: it says nothing about what the handler did.
   */
  fromServer?: boolean;
  cause?: unknown;
}

/**
 * Every failure of the API client. The `message` is the i18n key, never user-facing text or
 * server prose. `details` is different: it is server-supplied data (amounts, limits, field
 * paths) and may hold personal data. It is kept in a private field behind a getter, so it is not
 * an own enumerable property: `Object.keys`, spread, `JSON.stringify` (`toJSON` leaves it out too)
 * and most loggers and error reporters never see it. Read `error.details` deliberately, through
 * `errorDetails`, when the UI needs it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSec: number | undefined;
  readonly fromServer: boolean;
  readonly messageKey: ApiErrorMessageKey;
  readonly #details: unknown;

  constructor(init: ApiErrorInit) {
    const messageKey = errorKey(init.code);
    super(messageKey, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.#details = init.details;
    this.retryAfterSec = init.retryAfterSec;
    this.fromServer = init.fromServer ?? false;
    this.messageKey = messageKey;
  }

  get details(): unknown {
    return this.#details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      messageKey: this.messageKey,
      retryAfterSec: this.retryAfterSec,
    };
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Narrows an unknown wire `code` to a known one; anything else is `INTERNAL_ERROR`. */
export function toKnownCode(value: unknown): ErrorCode {
  const parsed = errorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'INTERNAL_ERROR';
}

/**
 * Parses `error.details` with the shared per-code schema (e.g. `TopupAmountOutOfRangeDetailsSchema`).
 * `undefined` when the error carries no details or they do not match: the UI then falls back to
 * the generic message instead of showing half-trusted numbers.
 */
export function errorDetails<S extends z.ZodType>(
  error: unknown,
  schema: S,
): z.infer<S> | undefined {
  if (!isApiError(error)) return undefined;
  const parsed = schema.safeParse(error.details);
  return parsed.success ? parsed.data : undefined;
}
