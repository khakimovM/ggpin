import { LedgerItemSchema, WalletResponseSchema } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWebAuth } from '../auth-web';
import { parseRetryAfter } from '../envelope';
import { ApiError, errorDetails, errorKey, isApiError, toKnownCode } from '../errors';
import { BASE, clientFor, failure, scripted, success } from './helpers';

const WALLET = { balanceTiyin: '12550000', coins: '150', currency: 'UZS' };

function client(script: Parameters<typeof scripted>[0], now?: () => number) {
  const { transport, calls } = scripted(script);
  const auth = createWebAuth({ apiBaseUrl: BASE, transport, onSessionLost: vi.fn() });
  return { api: clientFor(transport, auth, now), calls };
}

describe('response envelope', () => {
  it('returns schema-validated data from a success envelope', async () => {
    const { api } = client(() => success(WALLET));
    await expect(api.fetch({ path: '/me/wallet' }, WalletResponseSchema)).resolves.toEqual(WALLET);
  });

  it('keeps money as the exact string the server sent', async () => {
    const huge = '9223372036854775807';
    const { api } = client(() => success({ ...WALLET, balanceTiyin: huge }));
    const wallet = await api.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    expect(wallet.balanceTiyin).toBe(huge);
  });

  it('a schema mismatch becomes INTERNAL_ERROR without leaking values', async () => {
    const { api } = client(() => success({ ...WALLET, balanceTiyin: 12550000, secret: 'x' }));
    const error: unknown = await api
      .fetch({ path: '/me/wallet' }, WalletResponseSchema)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 200,
      messageKey: 'errors.INTERNAL_ERROR',
    });
    expect(JSON.stringify((error as { details: unknown }).details)).toBe(
      '{"fields":["balanceTiyin","(root)"]}',
    );
    expect(String(error)).not.toContain('12550000');
  });

  it('an unknown error code becomes INTERNAL_ERROR but keeps the HTTP status', async () => {
    const { api } = client(() => failure(422, 'SOMETHING_NEW'));
    await expect(api.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 422,
    });
  });

  it('maps a known code to its i18n key and exposes details', async () => {
    const details = { balance: '1000', required: '5000', shortfall: '4000' };
    const { api } = client(() => failure(422, 'INSUFFICIENT_BALANCE', details));
    const error: unknown = await api
      .fetch({ path: '/orders', method: 'POST' }, WalletResponseSchema)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      messageKey: 'errors.INSUFFICIENT_BALANCE',
      details,
    });
    const shape = z.object({ shortfall: z.string() });
    expect(errorDetails(error, shape)).toEqual({ shortfall: '4000' });
    expect(errorDetails(error, z.object({ min: z.string() }))).toBeUndefined();
  });

  it('a gateway page without our envelope still yields an ApiError with the status', async () => {
    const { api } = client(() => ({ status: 502, retryAfter: null, body: undefined }));
    await expect(api.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 502,
    });
  });

  it('only an answer in OUR envelope is marked fromServer (a proxy page, a missing body, a network failure are not)', async () => {
    const wallet = { path: '/me/wallet' };
    const ours = client(() => failure(404, 'NOT_FOUND')).api;
    await expect(ours.fetch(wallet, WalletResponseSchema)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      fromServer: true,
    });
    const html = client(() => ({ status: 404, retryAfter: null, body: undefined })).api;
    await expect(html.fetch(wallet, WalletResponseSchema)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      fromServer: false,
    });
    const brokenBody = client(() => ({ status: 200, retryAfter: null, body: { data: 1 } })).api;
    await expect(brokenBody.fetch(wallet, WalletResponseSchema)).rejects.toMatchObject({
      fromServer: false,
    });
    const offline = client(() => {
      throw new TypeError('Failed to fetch');
    }).api;
    await expect(offline.fetch(wallet, WalletResponseSchema)).rejects.toMatchObject({
      code: 'NETWORK',
      fromServer: false,
    });
  });

  it('a 200 without an envelope is INTERNAL_ERROR', async () => {
    const { api } = client(() => ({ status: 200, retryAfter: null, body: { data: WALLET } }));
    await expect(api.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('accepts a 204 when the schema allows no data', async () => {
    const { api } = client(() => ({ status: 204, retryAfter: null, body: undefined }));
    await expect(
      api.fetch({ method: 'DELETE', path: '/x' }, z.undefined()),
    ).resolves.toBeUndefined();
  });

  it('a transport failure is NETWORK with status 0', async () => {
    const { api } = client(() => {
      throw new TypeError('Failed to fetch');
    });
    const error: unknown = await api
      .fetch({ path: '/me/wallet' }, WalletResponseSchema)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NETWORK', status: 0, messageKey: 'common.error.network' });
  });

  it('lets an abort through so a cancelled query is not shown as an error', async () => {
    const { api } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error: unknown = await api
      .fetch({ path: '/me/wallet' }, WalletResponseSchema)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(false);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('reads Retry-After as seconds', async () => {
    const { api } = client(() => failure(429, 'RATE_LIMITED', undefined, '42'));
    await expect(
      api.fetch({ path: '/x', method: 'POST' }, WalletResponseSchema),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSec: 42,
    });
  });

  it('reads Retry-After as an HTTP date relative to the injected clock', async () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    const { api } = client(
      () => failure(429, 'RATE_LIMITED', undefined, 'Thu, 05 Nov 2026 10:01:30 GMT'),
      () => now,
    );
    await expect(
      api.fetch({ path: '/x', method: 'POST' }, WalletResponseSchema),
    ).rejects.toMatchObject({
      retryAfterSec: 90,
    });
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  it.each([
    [null, undefined],
    ['0', 0],
    ['30', 30],
    ['  7 ', 7],
    ['garbage', undefined],
    ['-5', undefined],
    ['99999999', 3600],
    ['Thu, 05 Nov 2026 09:00:00 GMT', 0],
  ])('%s -> %s', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe('lists', () => {
  it('returns items and page meta', async () => {
    const item = {
      id: 'l1',
      kind: 'TOPUP',
      amountTiyin: '500000',
      createdAt: '2026-11-05T10:00:00.000Z',
      orderId: null,
      paymentId: 'p1',
    };
    const { api } = client(() => success([item], { page: 1, limit: 20, total: 1 }));
    const page = await api.fetchList({ path: '/me/ledger' }, LedgerItemSchema);
    expect(page.items).toEqual([item]);
    expect(page.meta).toEqual({ page: 1, limit: 20, total: 1 });
  });

  it('a list without meta is a contract break', async () => {
    const { api } = client(() => success([]));
    await expect(api.fetchList({ path: '/me/ledger' }, LedgerItemSchema)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('error helpers', () => {
  it('toKnownCode falls back to INTERNAL_ERROR', () => {
    expect(toKnownCode('RATE_LIMITED')).toBe('RATE_LIMITED');
    expect(toKnownCode('NOPE')).toBe('INTERNAL_ERROR');
    expect(toKnownCode(42)).toBe('INTERNAL_ERROR');
  });

  it('errorKey maps server codes to errors.* and NETWORK to the common key', () => {
    expect(errorKey('QUOTE_EXPIRED')).toBe('errors.QUOTE_EXPIRED');
    expect(errorKey('NETWORK')).toBe('common.error.network');
  });
});

describe('ApiError serialisation', () => {
  it('toJSON leaves server-supplied details out, so loggers and reporters never carry them', () => {
    const error = new ApiError({
      status: 422,
      code: 'INSUFFICIENT_BALANCE',
      details: { balance: '1000', required: '5000' },
      retryAfterSec: 3,
    });
    const text = JSON.stringify(error);
    expect(text).not.toContain('1000');
    expect(text).not.toContain('details');
    expect(JSON.parse(text)).toEqual({
      name: 'ApiError',
      status: 422,
      code: 'INSUFFICIENT_BALANCE',
      messageKey: 'errors.INSUFFICIENT_BALANCE',
      retryAfterSec: 3,
    });
    // The caller can still read them on purpose.
    expect(error.details).toEqual({ balance: '1000', required: '5000' });
  });
});
