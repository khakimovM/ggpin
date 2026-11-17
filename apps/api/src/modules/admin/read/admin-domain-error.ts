import { AppError } from '../../../common/exceptions/app-error';

/**
 * The owner CLI's services refuse with `validationError(field, reason)` (details `{ field,
 * reason }`); the admin API speaks `details.fields: [{ path, code }]` (docs/04 «Xatolar (admin)»:
 * the code is the service's own reason). Runs `work` and re-shapes only that refusal.
 */
export async function withAdminFieldErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'VALIDATION_ERROR') throw error;
    const field = error.details?.['field'];
    if (typeof field !== 'string') throw error;
    const reason = error.details?.['reason'];
    const code = typeof reason === 'string' ? reason : 'INVALID';
    throw new AppError('VALIDATION_ERROR', { fields: [{ path: field, code }] });
  }
}
