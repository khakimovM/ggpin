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

  it('sets no response headers unless asked', () => {
    expect(new AppError('RATE_LIMITED').headers).toBeUndefined();
  });

  it.each([
    [42, '42'],
    [0.2, '1'],
    [41.1, '42'],
    [0, '1'],
    [-5, '1'],
    [Number.NaN, '1'],
    [Number.POSITIVE_INFINITY, '1'],
    [1e21, '86400'],
  ])('retryAfterSec %p becomes Retry-After %p (a valid delay-seconds)', (seconds, header) => {
    const error = new AppError('RATE_LIMITED', undefined, { retryAfterSec: seconds });
    expect(error.headers).toEqual({ 'Retry-After': header });
  });
});
