import {
  ADMIN_FIELD_ERROR_CODES,
  errorCodeSchema,
  type AdminFieldErrorCode,
  type ErrorCode,
} from '@repo/shared';
import { z } from 'zod';

/** Client-only code: the request never got an answer (offline, DNS, CORS, reset connection). */
export const NETWORK_CODE = 'NETWORK' as const;
export type ApiErrorCode = ErrorCode | typeof NETWORK_CODE;

/** i18n key of the text to show: the backend-owned `errors.*`, or the admin's network text. */
export type ApiErrorMessageKey = `errors.${ErrorCode}` | 'admin.states.network';

export function errorKey(code: ApiErrorCode): ApiErrorMessageKey {
  return code === NETWORK_CODE ? 'admin.states.network' : `errors.${code}`;
}

export interface ApiErrorInit {
  /** HTTP status; 0 when no response arrived. */
  status: number;
  code: ApiErrorCode;
  details?: unknown;
  /** Seconds from a valid `Retry-After` header. */
  retryAfterSec?: number;
  /** True only when the answer came in OUR error envelope, i.e. the API itself said it. */
  fromServer?: boolean;
}

/**
 * Every failure of the admin API client. `message` is the i18n key, never server prose.
 * `details` may hold server data (field paths, attempts left), so it sits in a private field
 * behind a getter: spread, `Object.keys` and `JSON.stringify` never see it.
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
    super(messageKey);
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
    return { name: this.name, status: this.status, code: this.code, messageKey: this.messageKey };
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

const fieldsDetails = z.object({
  fields: z.array(z.object({ path: z.string(), code: z.string() })),
});
const attemptsDetails = z.object({ attemptsLeft: z.number().int().min(0) });

/**
 * The admin domain code of a `400 VALIDATION_ERROR` for one field (`details.fields[].code`,
 * docs/04 "Xatolar (admin)"): `OTP_REQUIRED`, `OTP_LOCKED`, ... `undefined` for any other error,
 * for a Zod code, or for details that do not match.
 */
export function adminFieldCode(error: unknown, path: string): AdminFieldErrorCode | undefined {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return undefined;
  const parsed = fieldsDetails.safeParse(error.details);
  if (!parsed.success) return undefined;
  const code = parsed.data.fields.find((field) => field.path === path)?.code;
  return ADMIN_FIELD_ERROR_CODES.find((known) => known === code);
}

/** `details.attemptsLeft` of a `422 CODE_INVALID`, when the server sent a valid one. */
export function attemptsLeftOf(error: unknown): number | undefined {
  if (!isApiError(error) || error.code !== 'CODE_INVALID') return undefined;
  const parsed = attemptsDetails.safeParse(error.details);
  return parsed.success ? parsed.data.attemptsLeft : undefined;
}
