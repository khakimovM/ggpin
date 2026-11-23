import { describe, expect, it } from 'vitest';
import { actionErrorKey } from '../../../features/common/action-error-text';
import { ApiError, adminFieldErrors, isActionOutcomeUnknown, isOutcomeUnknown } from '../errors';

const server = (
  status: number,
  code: ConstructorParameters<typeof ApiError>[0]['code'],
  details?: unknown,
) => new ApiError({ status, code, fromServer: true, details });

describe('isActionOutcomeUnknown (SA-S6-7)', () => {
  it('a CODE_EXPIRED after a submit may be the twin of a committed request', () => {
    const expired = server(422, 'CODE_EXPIRED');
    expect(isOutcomeUnknown(expired)).toBe(false);
    expect(isActionOutcomeUnknown(expired)).toBe(true);
  });

  it('keeps every other unknown outcome and every definite refusal as before', () => {
    expect(isActionOutcomeUnknown(new ApiError({ status: 0, code: 'NETWORK' }))).toBe(true);
    expect(isActionOutcomeUnknown(server(500, 'INTERNAL_ERROR'))).toBe(true);
    expect(isActionOutcomeUnknown(server(409, 'IDEMPOTENCY_CONFLICT'))).toBe(true);
    expect(isActionOutcomeUnknown(server(422, 'CODE_INVALID', { attemptsLeft: 4 }))).toBe(false);
    expect(isActionOutcomeUnknown(server(400, 'VALIDATION_ERROR', { fields: [] }))).toBe(false);
  });
});

describe('field codes → admin.fieldErrors.*', () => {
  it('reads every fields[] entry and maps the first known code', () => {
    const error = server(400, 'VALIDATION_ERROR', {
      fields: [
        { path: 'x', code: 'SOMETHING_NEW' },
        { path: 'confirmAmountTiyin', code: 'AMOUNT_MISMATCH' },
      ],
    });
    expect(adminFieldErrors(error)).toHaveLength(2);
    expect(actionErrorKey(error)).toBe('admin.fieldErrors.amountMismatch');
  });

  it('an unknown code falls back to admin.fieldErrors.unknown, other errors to errors.*', () => {
    expect(
      actionErrorKey(server(400, 'VALIDATION_ERROR', { fields: [{ path: 'a', code: 'NEW' }] })),
    ).toBe('admin.fieldErrors.unknown');
    expect(actionErrorKey(server(404, 'NOT_FOUND'))).toBe('errors.NOT_FOUND');
    expect(actionErrorKey(new Error('x'))).toBe('admin.dialogs.failed');
  });
});
