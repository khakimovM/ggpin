import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, isOutcomeUnknown } from '../errors';
import { ME_PATH, createAdminHttp } from '../http';
import type { Transport, TransportRequest, TransportResponse } from '../transport';
import { WRITE_TIMEOUT_MS } from '../write-timeout';

const BASE = 'https://api.example.test/api/v1';
const anything = z.unknown();

function fail(status: number, code: string): TransportResponse {
  return {
    status,
    retryAfter: null,
    body: { success: false, error: { code, message: `errors.${code}` } },
  };
}

function setup(
  answer: (request: TransportRequest) => TransportResponse | Promise<TransportResponse>,
) {
  const transport: Transport = async (request) => answer(request);
  const onSessionLost = vi.fn();
  const http = createAdminHttp({
    baseUrl: BASE,
    transportFor: () => Promise.resolve(transport),
    onSessionLost,
    now: () => 1_000_000,
  });
  return { http, onSessionLost };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('admin http: write timeout (N-1)', () => {
  it('a keyed write without an answer ends as NETWORK after WRITE_TIMEOUT_MS and is aborted', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const { http } = setup((request) => {
        signal = request.signal;
        return new Promise<TransportResponse>(() => undefined);
      });
      const result = caught(
        http.fetch(
          { method: 'POST', path: '/admin/x', body: {}, idempotencyKey: 'key_00000001' },
          anything,
        ),
      );
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 0, code: 'NETWORK' });
      expect(isOutcomeUnknown(error)).toBe(true);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hanging session probe after a keyed write 404 times out as "unknown", not "gone" (F-2)', async () => {
    vi.useFakeTimers();
    try {
      const { http, onSessionLost } = setup((request) =>
        request.url.endsWith(ME_PATH)
          ? new Promise<TransportResponse>(() => undefined)
          : fail(404, 'NOT_FOUND'),
      );
      const result = caught(
        http.fetch(
          { method: 'POST', path: '/admin/x', body: {}, idempotencyKey: 'key_00000001' },
          anything,
        ),
      );
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
      expect(await result).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(onSessionLost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the key void (no Idempotency-Key) has the write timeout too: no verdict, never an answer', async () => {
    vi.useFakeTimers();
    try {
      const { http } = setup(() => new Promise<TransportResponse>(() => undefined));
      const result = caught(
        http.fetch(
          { method: 'POST', path: '/admin/write-keys/void', body: {}, writeTimeout: true },
          anything,
        ),
      );
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
      expect(await result).toMatchObject({ status: 0, code: 'NETWORK' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the API deadline 503 proves nothing was written; a proxy 503 does not (9-B Q3)', () => {
    const own = new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED', fromServer: true });
    expect(isOutcomeUnknown(own)).toBe(false);
    const proxy = new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED' });
    expect(isOutcomeUnknown(proxy)).toBe(true);
    const other = new ApiError({ status: 503, code: 'PRICE_UNAVAILABLE', fromServer: true });
    expect(isOutcomeUnknown(other)).toBe(true);
  });

  it('a read has no timeout of its own', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const { http } = setup(() => new Promise<TransportResponse>(() => undefined));
      void caught(http.fetch({ path: '/admin/x' }, anything)).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS * 2);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
