import { ERROR_CODES, ERROR_HTTP_STATUS } from '@repo/shared';
import { AppError } from '../app-error';

describe('AppError', () => {
  it.each(ERROR_CODES)('%s takes its status from the contract table', (code) => {
    const error = new AppError(code);
    expect(error.status).toBe(ERROR_HTTP_STATUS[code]);
    expect(error.message).toBe(`errors.${code}`);
    expect(error.code).toBe(code);
  });

  it('carries details', () => {
    const error = new AppError('INSUFFICIENT_BALANCE', { balance: 1n });
    expect(error.details).toEqual({ balance: 1n });
    expect(error).toBeInstanceOf(Error);
  });
});
