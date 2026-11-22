import {
  ADMIN_OTP_SERVICE_REASONS,
  adminOtpHttpError,
  type AdminOtpServiceReason,
} from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';

const OTP_REASONS: ReadonlySet<string> = new Set(ADMIN_OTP_SERVICE_REASONS);

function isOtpReason(reason: unknown): reason is AdminOtpServiceReason {
  return typeof reason === 'string' && OTP_REASONS.has(reason);
}

/**
 * The owner services' refusals in the admin vocabulary (docs/04 «Xatolar (admin)», D-65 D5):
 * `validationError(field, reason)` becomes `details.fields: [{ path, code }]`; the step-up
 * reasons go through `adminOtpHttpError`, so no raw OTP_EXPIRED / OTP_MISMATCH / OTP_INVALID
 * leaves an admin route. A re-typed amount refused without a reason (the CLI's frozen shape in
 * `requireOwnerConfirmation`) is `AMOUNT_MISMATCH`. Anything else passes unchanged.
 */
export function adminWriteError(error: unknown): unknown {
  if (!(error instanceof AppError) || error.code !== 'VALIDATION_ERROR') return error;
  const field = error.details?.['field'];
  if (typeof field !== 'string') return error;
  const reason = error.details?.['reason'];
  if (isOtpReason(reason)) {
    const mapped = adminOtpHttpError(reason);
    if (mapped.status === 400) {
      return new AppError('VALIDATION_ERROR', { fields: [mapped.field] });
    }
    // A code the service refused AFTER it was used (the state changed since it was issued):
    // nothing is left to try with it.
    return mapped.code === 'CODE_INVALID'
      ? new AppError('CODE_INVALID', { attemptsLeft: 0 })
      : new AppError(mapped.code);
  }
  if (field === 'confirmAmountTiyin' && reason === undefined) {
    return new AppError('VALIDATION_ERROR', {
      fields: [{ path: 'confirmAmountTiyin', code: 'AMOUNT_MISMATCH' }],
    });
  }
  const code = typeof reason === 'string' ? reason : 'INVALID';
  return new AppError('VALIDATION_ERROR', { fields: [{ path: field, code }] });
}
