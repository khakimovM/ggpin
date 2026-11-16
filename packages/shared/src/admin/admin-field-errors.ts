// One vocabulary for the step-up refusals of the admin API (D-65 D5, docs/04 "Admin" — errors).
// The shared OTP service (owner CLI and panel) refuses with `validationError(field, reason)`;
// the admin HTTP layer maps those reasons here, so the panel and the CLI speak the same names and
// no raw service reason that would tell WHY a code failed (expired vs. wrong binding) leaks.
import type { ErrorCode } from '../errors';

/** Domain codes the admin API may put in `details.fields[].code` (next to Zod's own codes). */
export const ADMIN_FIELD_ERROR_CODES = Object.freeze([
  'OTP_REQUIRED',
  /** Money actions only: the re-typed `confirmAmountTiyin` is not the real amount. */
  'AMOUNT_MISMATCH',
  'OTP_LOCKED',
  'OTP_UNAVAILABLE',
  /** `POST /admin/confirmations` for an action that would not ask for a code (SA-M1). */
  'OTP_NOT_REQUIRED',
  /** `POST /admin/fx`: the re-typed `confirmRate` is not the rate being set (review m-5). */
  'RATE_MISMATCH',
] as const);
export type AdminFieldErrorCode = (typeof ADMIN_FIELD_ERROR_CODES)[number];

/** Reasons the OTP service gives (`owner-otp.ts`; `AMOUNT_MISMATCH` joins them in S6). */
export const ADMIN_OTP_SERVICE_REASONS = [
  'OTP_REQUIRED',
  'AMOUNT_MISMATCH',
  'OTP_LOCKED',
  'OTP_UNAVAILABLE',
  'OTP_INVALID',
  'OTP_MISMATCH',
  'OTP_EXPIRED',
] as const;
export type AdminOtpServiceReason = (typeof ADMIN_OTP_SERVICE_REASONS)[number];

export type AdminOtpHttpError =
  | {
      readonly status: 400;
      readonly code: 'VALIDATION_ERROR';
      readonly field: {
        readonly path: 'otp' | 'confirmAmountTiyin' | 'confirmRate' | 'action';
        readonly code: AdminFieldErrorCode;
      };
    }
  | { readonly status: 422; readonly code: Extract<ErrorCode, 'CODE_INVALID' | 'CODE_EXPIRED'> };

/**
 * The HTTP answer for one service reason. A wrong code and a code issued for another binding are
 * the same `422 CODE_INVALID` (+ `attemptsLeft`), so the answer is no oracle for what the code was
 * bound to; expired, unknown and used codes are `422 CODE_EXPIRED`. The attempt is counted before
 * the comparison (phase 4 rule), in the service.
 */
export function adminOtpHttpError(reason: AdminOtpServiceReason): AdminOtpHttpError {
  switch (reason) {
    case 'OTP_INVALID':
    case 'OTP_MISMATCH':
      return { status: 422, code: 'CODE_INVALID' };
    case 'OTP_EXPIRED':
      return { status: 422, code: 'CODE_EXPIRED' };
    case 'AMOUNT_MISMATCH':
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        field: { path: 'confirmAmountTiyin', code: 'AMOUNT_MISMATCH' },
      };
    case 'OTP_REQUIRED':
    case 'OTP_LOCKED':
    case 'OTP_UNAVAILABLE':
      return { status: 400, code: 'VALIDATION_ERROR', field: { path: 'otp', code: reason } };
  }
}

/** `POST /admin/confirmations` for an action that needs no code now: nothing is sent (SA-M1). */
export const ADMIN_OTP_NOT_REQUIRED_ERROR = Object.freeze({
  status: 400,
  code: 'VALIDATION_ERROR',
  field: Object.freeze({ path: 'action', code: 'OTP_NOT_REQUIRED' }),
} as const satisfies AdminOtpHttpError);

/**
 * `POST /admin/fx` when the jump rule asks for `confirmRate` and it differs from `rate` (phase 5
 * FxAdminService `validationError('confirmRate')`): its own name, not `AMOUNT_MISMATCH`, which
 * is only about money (review m-5).
 */
export const ADMIN_RATE_MISMATCH_ERROR = Object.freeze({
  status: 400,
  code: 'VALIDATION_ERROR',
  field: Object.freeze({ path: 'confirmRate', code: 'RATE_MISMATCH' }),
} as const satisfies AdminOtpHttpError);
