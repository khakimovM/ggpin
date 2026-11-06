import { describe, expect, it } from 'vitest';
import { ApiError } from './api/errors';
import {
  DEFAULT_STALE_TIME_MS,
  MAX_QUERY_RETRIES,
  makeQueryClient,
  shouldRetry,
} from './query-client';

describe('shouldRetry', () => {
  it.each([400, 401, 403, 404, 409, 422, 429, 499])('never retries HTTP %i', (status) => {
    expect(shouldRetry(0, { status })).toBe(false);
  });

  it.each([500, 502, 503])('retries HTTP %i twice, then gives up', (status) => {
    expect(shouldRetry(0, { status })).toBe(true);
    expect(shouldRetry(1, { status })).toBe(true);
    expect(shouldRetry(MAX_QUERY_RETRIES, { status })).toBe(false);
  });

  it('retries a network error (no status) twice', () => {
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(1, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(2, new TypeError('Failed to fetch'))).toBe(false);
  });

  it('ignores a non-numeric status', () => {
    expect(shouldRetry(0, { status: '404' })).toBe(true);
  });

  describe('with ApiError', () => {
    it('retries NETWORK (status 0) and 5xx', () => {
      expect(shouldRetry(0, new ApiError({ status: 0, code: 'NETWORK' }))).toBe(true);
      expect(shouldRetry(0, new ApiError({ status: 503, code: 'PRICE_UNAVAILABLE' }))).toBe(true);
    });

    it('does not retry a 4xx or a response that failed schema validation', () => {
      expect(shouldRetry(0, new ApiError({ status: 422, code: 'INSUFFICIENT_BALANCE' }))).toBe(
        false,
      );
      expect(shouldRetry(0, new ApiError({ status: 401, code: 'UNAUTHORIZED' }))).toBe(false);
      // Status 200 + INTERNAL_ERROR is a contract break: the same bytes will fail again.
      expect(shouldRetry(0, new ApiError({ status: 200, code: 'INTERNAL_ERROR' }))).toBe(false);
    });
  });
});

describe('makeQueryClient', () => {
  it('uses the retry policy and the documented default staleTime', () => {
    const queries = makeQueryClient().getDefaultOptions().queries;
    expect(queries?.retry).toBe(shouldRetry);
    expect(queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
  });

  it('never retries a mutation on its own', () => {
    expect(makeQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('creates an isolated client per call', () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient());
  });
});
