// Error codes and HTTP statuses: docs/04-API-CONTRACT.md "Xato kodlari" (+ D-24).
// `message` on the wire is the i18n key `errors.<CODE>`; the text lives in packages/i18n.
import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'INITDATA_INVALID',
  'INITDATA_EXPIRED',
  'TOKEN_REUSE_DETECTED',
  'USER_BLOCKED',
  'PURCHASE_FROZEN',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'QUOTE_EXPIRED',
  'PAYLOAD_TOO_LARGE',
  'INSUFFICIENT_BALANCE',
  'RECIPIENT_NOT_FOUND',
  'RECIPIENT_INVALID',
  'RECIPIENT_HAS_PREMIUM',
  'PRODUCT_UNAVAILABLE',
  'OUT_OF_STOCK',
  'QTY_OUT_OF_RANGE',
  'TOPUP_AMOUNT_OUT_OF_RANGE',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'CODE_ALREADY_USED',
  'NOT_ENOUGH_COINS',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'FULFILLMENT_UNAVAILABLE',
  'RECIPIENT_CHECK_UNAVAILABLE',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// Record<ErrorCode, …> makes adding a code without a status a compile error.
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  INITDATA_INVALID: 401,
  INITDATA_EXPIRED: 401,
  TOKEN_REUSE_DETECTED: 401,
  USER_BLOCKED: 403,
  PURCHASE_FROZEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  QUOTE_EXPIRED: 410,
  PAYLOAD_TOO_LARGE: 413,
  INSUFFICIENT_BALANCE: 422,
  RECIPIENT_NOT_FOUND: 422,
  RECIPIENT_INVALID: 422,
  RECIPIENT_HAS_PREMIUM: 422,
  PRODUCT_UNAVAILABLE: 422,
  OUT_OF_STOCK: 422,
  QTY_OUT_OF_RANGE: 422,
  TOPUP_AMOUNT_OUT_OF_RANGE: 422,
  CODE_INVALID: 422,
  CODE_EXPIRED: 422,
  CODE_ALREADY_USED: 422,
  NOT_ENOUGH_COINS: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  FULFILLMENT_UNAVAILABLE: 503,
  RECIPIENT_CHECK_UNAVAILABLE: 503,
};

/** The wire `message` for an error: the i18n key, never user-facing text. */
export function errorMessageKey(code: ErrorCode): `errors.${ErrorCode}` {
  return `errors.${code}`;
}
