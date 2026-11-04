import { describe, expect, it } from 'vitest';
import { DEFAULT_STALE_TIME_MS, makeQueryClient, shouldRetry } from './query-client';

describe('shouldRetry', () => {
  it.each([400, 401, 403, 404, 409, 422, 429, 499])('never retries HTTP %i', (status) => {
    expect(shouldRetry(0, { status })).toBe(false);
  });

  it.each([500, 502, 503])('retries HTTP %i once', (status) => {
    expect(shouldRetry(0, { status })).toBe(true);
    expect(shouldRetry(1, { status })).toBe(false);
  });

  it('retries a network error (no status) once', () => {
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(1, new TypeError('Failed to fetch'))).toBe(false);
  });

  it('ignores a non-numeric status', () => {
    expect(shouldRetry(0, { status: '404' })).toBe(true);
  });
});

describe('makeQueryClient', () => {
  it('uses the retry policy and the documented default staleTime', () => {
    const queries = makeQueryClient().getDefaultOptions().queries;
    expect(queries?.retry).toBe(shouldRetry);
    expect(queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
  });

  it('creates an isolated client per call', () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient());
  });
});
