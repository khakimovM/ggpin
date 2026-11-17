import { CSRF_HEADER } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, adminFieldCode, attemptsLeftOf } from '../errors';
import { ME_PATH, buildRequest, createAdminHttp } from '../http';
import type { Transport, TransportRequest, TransportResponse } from '../transport';

const BASE = 'https://api.example.test/api/v1';
const anything = z.unknown();

function ok(data: unknown, meta?: unknown): TransportResponse {
  return {
    status: 200,
    retryAfter: null,
    body: { success: true, data, ...(meta === undefined ? {} : { meta }) },
  };
}

function fail(
  status: number,
  code: string,
  details?: unknown,
  retryAfter: string | null = null,
): TransportResponse {
  return {
    status,
    retryAfter,
    body: { success: false, error: { code, message: `errors.${code}`, details } },
  };
}

type Answer = (request: TransportRequest) => TransportResponse | Promise<TransportResponse>;

function setup(answer: Answer) {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    return answer(request);
  };
  const onSessionLost = vi.fn();
  const http = createAdminHttp({
    baseUrl: BASE,
    transportFor: () => Promise.resolve(transport),
    onSessionLost,
    now: () => 1_000_000,
  });
  return { http, calls, onSessionLost };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('admin http: CSRF', () => {
  it('sends the CSRF header on every write', () => {
    for (const method of ['POST', 'PATCH'] as const) {
      const request = buildRequest(BASE, { method, path: '/admin/x', body: {} });
      expect(request.headers[CSRF_HEADER]).toBe('1');
    }
  });

  it('sends no CSRF header on a read', () => {
    expect(buildRequest(BASE, { path: '/admin/x' }).headers[CSRF_HEADER]).toBeUndefined();
  });

  it('puts the header on the wire through the client', async () => {
    const { http, calls } = setup(() => ok({}));
    await http.fetch({ method: 'POST', path: '/admin/auth/logout', body: {} }, anything);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
    expect(calls[0]?.url).toBe(`${BASE}/admin/auth/logout`);
    expect(calls[0]?.body).toBe('{}');
  });

  it('validates the Idempotency-Key before anything is sent', async () => {
    const { http, calls } = setup(() => ok({}));
    const error = await caught(
      http.fetch(
        { method: 'POST', path: '/admin/x', body: {}, idempotencyKey: 'bad key!' },
        anything,
      ),
    );
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toHaveLength(0);
    const attempt = crypto.randomUUID();
    const headers = buildRequest(BASE, {
      method: 'POST',
      path: '/a',
      idempotencyKey: attempt,
    }).headers;
    expect(headers['idempotency-key']).toBe(attempt);
  });
});

describe('admin http: 404 means sign-out only when the session is gone', () => {
  it('treats a 404 on me as a lost session', async () => {
    const { http, onSessionLost } = setup(() => fail(404, 'NOT_FOUND'));
    expect(await caught(http.fetch({ path: ME_PATH }, anything))).toMatchObject({ status: 404 });
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it('asks me after a 404 elsewhere and signs out when me is 404 too', async () => {
    const { http, calls, onSessionLost } = setup(() => fail(404, 'NOT_FOUND'));
    expect(await caught(http.fetch({ path: '/admin/orders/x' }, anything))).toBeInstanceOf(
      ApiError,
    );
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/admin/orders/x`, `${BASE}${ME_PATH}`]);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when me still answers: the 404 was a record or a role', async () => {
    const { http, onSessionLost } = setup((request) =>
      request.url.endsWith(ME_PATH) ? ok({}) : fail(404, 'NOT_FOUND'),
    );
    expect(await caught(http.fetch({ path: '/admin/admins' }, anything))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('keeps the session when the probe itself fails (no answer says nothing)', async () => {
    const { http, onSessionLost } = setup((request) => {
      if (request.url.endsWith(ME_PATH)) throw new TypeError('offline');
      return fail(404, 'NOT_FOUND');
    });
    expect(await caught(http.fetch({ path: '/admin/x' }, anything))).toBeInstanceOf(ApiError);
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('never probes on the open login routes (a 404 there is an expired nonce)', async () => {
    const { http, calls, onSessionLost } = setup(() => fail(404, 'NOT_FOUND'));
    const error = await caught(
      http.fetch({ path: '/admin/auth/status/abc', session: 'none' }, anything),
    );
    expect(error).toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('probes once for several 404s arriving together', async () => {
    const { http, calls, onSessionLost } = setup(() => fail(404, 'NOT_FOUND'));
    await Promise.allSettled([
      http.fetch({ path: '/admin/a' }, anything),
      http.fetch({ path: '/admin/b' }, anything),
    ]);
    expect(calls.filter((call) => call.url.endsWith(ME_PATH))).toHaveLength(1);
    expect(onSessionLost).toHaveBeenCalledTimes(2);
  });
});

describe('admin http: envelope and error mapping', () => {
  it('returns data checked by the schema', async () => {
    const { http } = setup(() => ok({ id: 'a1' }));
    const data = await http.fetch({ path: '/admin/x' }, z.object({ id: z.string() }));
    expect(data).toEqual({ id: 'a1' });
  });

  it('turns a body that breaks the contract into INTERNAL_ERROR', async () => {
    const { http } = setup(() => ok({ id: 1 }));
    const error = await caught(http.fetch({ path: '/admin/x' }, z.object({ id: z.string() })));
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('maps 422 CODE_INVALID with attemptsLeft', async () => {
    const { http } = setup(() => fail(422, 'CODE_INVALID', { attemptsLeft: 3 }));
    const error = await caught(
      http.fetch(
        { method: 'POST', path: '/admin/auth/verify', body: {}, session: 'none' },
        anything,
      ),
    );
    expect(error).toMatchObject({
      status: 422,
      code: 'CODE_INVALID',
      messageKey: 'errors.CODE_INVALID',
    });
    expect(attemptsLeftOf(error)).toBe(3);
  });

  it('maps an admin field code of a 400', async () => {
    const { http } = setup(() =>
      fail(400, 'VALIDATION_ERROR', { fields: [{ path: 'otp', code: 'OTP_LOCKED' }] }),
    );
    const error = await caught(
      http.fetch({ method: 'POST', path: '/admin/x', body: {} }, anything),
    );
    expect(adminFieldCode(error, 'otp')).toBe('OTP_LOCKED');
    expect(adminFieldCode(error, 'reason')).toBeUndefined();
  });

  it('maps 429 with Retry-After', async () => {
    const { http } = setup(() => fail(429, 'RATE_LIMITED', undefined, '42'));
    expect(await caught(http.fetch({ path: '/admin/x' }, anything))).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSec: 42,
    });
  });

  it('maps an unknown server code to INTERNAL_ERROR and a proxy page by its status', async () => {
    const unknown = setup(() => fail(500, 'SOMETHING_NEW'));
    expect(await caught(unknown.http.fetch({ path: '/admin/x' }, anything))).toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    const proxy = setup(() => ({ status: 429, retryAfter: null, body: undefined }));
    expect(await caught(proxy.http.fetch({ path: '/admin/x' }, anything))).toMatchObject({
      code: 'RATE_LIMITED',
      fromServer: false,
    });
  });

  it('maps a transport failure to NETWORK (status 0)', async () => {
    const { http } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await caught(http.fetch({ path: '/admin/x' }, anything))).toMatchObject({
      status: 0,
      code: 'NETWORK',
      messageKey: 'admin.states.network',
    });
  });

  it('lets an abort through untouched', async () => {
    const { http } = setup(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await caught(http.fetch({ path: '/admin/x' }, anything))).toMatchObject({
      name: 'AbortError',
    });
  });

  it('requires meta on a list', async () => {
    const meta = { page: 1, limit: 20, total: 1 };
    const withMeta = setup(() => ok([{ id: 'a' }], meta));
    const list = await withMeta.http.fetchList({ path: '/admin/x' }, z.object({ id: z.string() }));
    expect(list).toEqual({ items: [{ id: 'a' }], meta });
    const without = setup(() => ok([]));
    expect(await caught(without.http.fetchList({ path: '/admin/x' }, anything))).toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
