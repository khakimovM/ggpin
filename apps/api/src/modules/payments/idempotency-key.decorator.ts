import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { IdempotencyKeySchema } from '@repo/shared';
import type { AuthRequest } from '../../common/auth/auth-user';
import { AppError } from '../../common/exceptions/app-error';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * The `Idempotency-Key` header (docs/04: required on intent creation, 8-128 chars of
 * A-Z a-z 0-9 _ -). Missing or malformed is a 400 VALIDATION_ERROR shaped like a schema error.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const value = context.switchToHttp().getRequest<AuthRequest>().headers[IDEMPOTENCY_HEADER];
    if (typeof value !== 'string') {
      throw new AppError('VALIDATION_ERROR', {
        fields: [{ path: 'Idempotency-Key', code: 'required' }],
      });
    }
    const parsed = IdempotencyKeySchema.safeParse(value);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', {
        fields: [{ path: 'Idempotency-Key', code: 'invalid_format' }],
      });
    }
    return parsed.data;
  },
);
