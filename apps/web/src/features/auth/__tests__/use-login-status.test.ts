import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { POLL_INTERVAL_MS, POLL_MAX_MS } from '../login-machine';
import { nextPollDelayMs } from '../use-login-status';

describe('nextPollDelayMs', () => {
  it('polls every 2 seconds while PENDING (or before the first answer)', () => {
    expect(nextPollDelayMs('PENDING', null, 5_000)).toBe(POLL_INTERVAL_MS);
    expect(nextPollDelayMs(undefined, null, 0)).toBe(POLL_INTERVAL_MS);
  });

  it('stops on every answer that ends the wait, and after the nonce lifetime', () => {
    for (const status of ['CODE_SENT', 'DENIED', 'EXPIRED'] as const) {
      expect(nextPollDelayMs(status, null, 1_000)).toBe(false);
    }
    expect(nextPollDelayMs('PENDING', null, POLL_MAX_MS)).toBe(false);
    expect(nextPollDelayMs(undefined, new Error('x'), POLL_MAX_MS + 1)).toBe(false);
  });

  it('after a 429 waits for Retry-After instead of polling through the limit', () => {
    const limited = (retryAfterSec?: number) =>
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec });
    expect(nextPollDelayMs('PENDING', limited(30), 1_000)).toBe(30_000);
    expect(nextPollDelayMs(undefined, limited(1), 1_000)).toBe(POLL_INTERVAL_MS); // never faster
    expect(nextPollDelayMs(undefined, limited(), 1_000)).toBe(10_000); // no usable header
  });

  it('other failures (a dropped connection) keep the normal pace', () => {
    expect(nextPollDelayMs(undefined, new ApiError({ status: 0, code: 'NETWORK' }), 1_000)).toBe(
      POLL_INTERVAL_MS,
    );
    expect(
      nextPollDelayMs(undefined, new ApiError({ status: 500, code: 'INTERNAL_ERROR' }), 1),
    ).toBe(POLL_INTERVAL_MS);
  });
});
