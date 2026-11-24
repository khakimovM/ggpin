import {
  ADMIN_CATALOG_FIELD_ERROR_CODES,
  ADMIN_FIELD_ERROR_CODES,
  errorCodeSchema,
  type AdminCatalogFieldErrorCode,
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
 * `quantity` of an admin price preview outside the product's range (the catalog read path, S8a
 * CR m3): a field code like the write ones, though no shared list names it.
 */
export const ADMIN_PREVIEW_FIELD_ERROR_CODES = ['QTY_OUT_OF_RANGE'] as const;

/** Every domain field code the panel knows by name: step-up, catalog writes, catalog preview. */
export const KNOWN_ADMIN_FIELD_CODES = [
  ...ADMIN_FIELD_ERROR_CODES,
  ...ADMIN_CATALOG_FIELD_ERROR_CODES,
  ...ADMIN_PREVIEW_FIELD_ERROR_CODES,
] as const;
export type KnownAdminFieldCode =
  | AdminFieldErrorCode
  | AdminCatalogFieldErrorCode
  | (typeof ADMIN_PREVIEW_FIELD_ERROR_CODES)[number];

/**
 * The admin domain code of a `400 VALIDATION_ERROR` for one field (`details.fields[].code`,
 * docs/04 "Xatolar (admin)"): `OTP_REQUIRED`, `OTP_LOCKED`, the catalog's `DUPLICATE_PACKAGE`,
 * `QUANTITY_RANGE`... (CR m2). `undefined` for any other error, for a Zod code, or for details
 * that do not match.
 */
export function adminFieldCode(error: unknown, path: string): KnownAdminFieldCode | undefined {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return undefined;
  const parsed = fieldsDetails.safeParse(error.details);
  if (!parsed.success) return undefined;
  const code = parsed.data.fields.find((field) => field.path === path)?.code;
  return KNOWN_ADMIN_FIELD_CODES.find((known) => known === code);
}

/** `details.attemptsLeft` of a `422 CODE_INVALID`, when the server sent a valid one. */
export function attemptsLeftOf(error: unknown): number | undefined {
  if (!isApiError(error) || error.code !== 'CODE_INVALID') return undefined;
  const parsed = attemptsDetails.safeParse(error.details);
  return parsed.success ? parsed.data.attemptsLeft : undefined;
}

/**
 * A submit that sent nothing (its inputs were not ready, SA I-2). Thrown instead of resolving, so
 * the form never takes it for a 2xx and never ends the key; it is a definite "not applied".
 */
export class NotSentError extends Error {
  constructor() {
    super('not sent');
    this.name = 'NotSentError';
  }
}

/**
 * `503 ADMIN_DEADLINE_EXCEEDED` in our own envelope (docs/04 «So‘rov deadline’i», 9-B Q3): the
 * API refused the write after 45 s and wrote nothing, the key stays free, a resend is safe. Only
 * the API's envelope with status 503 counts: a proxy's 503 says nothing about the write, and the
 * code under any other status is not the deadline answer docs/04 defines (CR-5, SA I-4).
 */
export function isDeadlineExceeded(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.fromServer &&
    error.status === 503 &&
    error.code === 'ADMIN_DEADLINE_EXCEEDED'
  );
}

/**
 * Whether a failed write may still have been applied by the server (SA M-1): no answer at all
 * (NETWORK, status 0), an answer not in our envelope (a proxy said it), any 5xx but the API's
 * own deadline refusal, or a 409 IDEMPOTENCY_CONFLICT (the key was already used, so an earlier
 * attempt may have run). Only a 4xx or a deadline 503 in our own envelope proves the action did
 * not happen.
 */
export function isOutcomeUnknown(error: unknown): boolean {
  if (error instanceof NotSentError) return false;
  if (!isApiError(error)) return true;
  if (isDeadlineExceeded(error)) return false;
  if (!error.fromServer || error.status === 0 || error.status >= 500) return true;
  return error.code === 'IDEMPOTENCY_CONFLICT';
}

/**
 * `isOutcomeUnknown` for the answer to an action that was SENT (SA-S6-7, docs/04 «Idempotency-Key»):
 * a `422 CODE_EXPIRED` may be the twin of a request with the same key and code that committed
 * first, so it proves nothing either. Never for `POST /admin/confirmations` (no write there).
 */
export function isActionOutcomeUnknown(error: unknown): boolean {
  return isOutcomeUnknown(error) || (isApiError(error) && error.code === 'CODE_EXPIRED');
}

export interface AdminFieldError {
  path: string;
  code: string;
}

/** Every `details.fields[]` entry of a `400 VALIDATION_ERROR` as sent; empty for anything else. */
export function adminFieldErrors(error: unknown): AdminFieldError[] {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return [];
  const parsed = fieldsDetails.safeParse(error.details);
  return parsed.success ? parsed.data.fields : [];
}

/** 409 IDEMPOTENCY_CONFLICT: the key was already used with another body (docs/04 "Admin"). */
export function isIdempotencyConflict(error: unknown): boolean {
  return isApiError(error) && error.code === 'IDEMPOTENCY_CONFLICT';
}
