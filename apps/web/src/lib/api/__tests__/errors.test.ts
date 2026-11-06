import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, errorDetails } from '../errors';

const DETAILS = { balance: '1000', required: '5000', shortfall: '4000' };

describe('ApiError.details', () => {
  const error = new ApiError({ status: 422, code: 'INSUFFICIENT_BALANCE', details: DETAILS });

  it('is readable through the getter and errorDetails', () => {
    expect(error.details).toEqual(DETAILS);
    expect(errorDetails(error, z.object({ shortfall: z.string() }))).toEqual({ shortfall: '4000' });
  });

  it('is not an own enumerable property: keys, spread and JSON never carry it', () => {
    expect(Object.keys(error)).not.toContain('details');
    expect(Object.keys({ ...error })).not.toContain('details');
    expect(Object.getOwnPropertyDescriptor(error, 'details')).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('details');
    expect(JSON.stringify(error)).not.toContain('5000');
    expect(JSON.stringify({ wrapped: error })).not.toContain('5000');
  });

  it('keeps the rest of the error visible to loggers', () => {
    expect(Object.keys(error).sort()).toEqual([
      'code',
      'messageKey',
      'name',
      'retryAfterSec',
      'status',
    ]);
    expect(error.message).toBe('errors.INSUFFICIENT_BALANCE');
  });

  it('an error without details reads undefined', () => {
    expect(new ApiError({ status: 0, code: 'NETWORK' }).details).toBeUndefined();
  });
});
