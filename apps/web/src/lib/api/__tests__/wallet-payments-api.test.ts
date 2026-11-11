import {
  CSRF_HEADER,
  TopupAlreadyPendingDetailsSchema,
  TopupAmountOutOfRangeDetailsSchema,
  type LedgerItem,
} from '@repo/shared';
import type { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDEMPOTENCY_KEY } from './helpers';
import {
  INTENT_ID,
  LEDGER,
  METHODS,
  PAY_TOKEN,
  WALLET,
  intent,
  intentCreated,
  payView,
} from './payment-fixtures';

// The wallet and top-up API functions over a stubbed `fetch` (the mock groups are gone, phase 4 is
// real). These cover what the deleted mock-handler tests did for the web side: the request each
// function sends and how it reads the answer, including the error envelopes the real API sends.
// What the real API answers is proven against it in e2e/journeys/contract-check.real.spec.ts.

interface Seen {
  url: string;
  init: RequestInit;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const ok = (data: unknown, status = 200, meta?: unknown): Response =>
  json({ success: true, data, ...(meta === undefined ? {} : { meta }) }, status);
const fail = (
  status: number,
  code: string,
  details?: unknown,
  headers?: Record<string, string>,
): Response =>
  json({ success: false, error: { code, message: `errors.${code}`, details } }, status, headers);

function stubFetch(answer: (seen: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const entry = { url, init };
      seen.push(entry);
      return Promise.resolve(answer(entry));
    }),
  );
  return seen;
}

// resetModules gives each test a fresh ApiError class: errorDetails must come from the same registry.
async function detailsOf<S extends z.ZodType>(error: unknown, schema: S) {
  const { errorDetails } = await import('../errors');
  return errorDetails(error, schema);
}

const API = 'http://localhost:5000/api/v1';
const headersOf = (seen: Seen | undefined): Record<string, string> =>
  (seen?.init.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wallet', () => {
  it('getWallet reads the server balance as a string, over the cookie channel', async () => {
    const seen = stubFetch(() => ok(WALLET));
    const { getWallet } = await import('../me');
    await expect(getWallet()).resolves.toEqual(WALLET);
    expect(seen[0]?.url).toBe(`${API}/me/wallet`);
    expect(seen[0]?.init.credentials).toBe('include');
  });

  it('getWallet keeps a negative balance (a reversal after the money was spent)', async () => {
    stubFetch(() => ok({ ...WALLET, balanceTiyin: '-550000' }));
    const { getWallet } = await import('../me');
    await expect(getWallet()).resolves.toMatchObject({ balanceTiyin: '-550000' });
  });

  it('a wallet whose amount is a float is refused, not shown', async () => {
    stubFetch(() => ok({ ...WALLET, balanceTiyin: 125.5 }));
    const { getWallet } = await import('../me');
    await expect(getWallet()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('getLedger sends the filter and page as query and returns the rows with the page meta', async () => {
    const seen = stubFetch(() => ok(LEDGER, 200, { page: 2, limit: 2, total: 5 }));
    const { getLedger } = await import('../me');
    const result = await getLedger({ kind: 'PURCHASE', page: 2, limit: 2 });
    const url = new URL(seen[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/me/ledger');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'PURCHASE',
      page: '2',
      limit: '2',
    });
    expect(result.meta).toEqual({ page: 2, limit: 2, total: 5 });
    expect(result.items.map((row: LedgerItem) => row.kind)).toEqual(['PURCHASE', 'TOPUP']);
  });

  it('an empty ledger is an empty list, not an error', async () => {
    stubFetch(() => ok([], 200, { page: 1, limit: 20, total: 0 }));
    const { getLedger } = await import('../me');
    await expect(getLedger()).resolves.toEqual({
      items: [],
      meta: { page: 1, limit: 20, total: 0 },
    });
  });
});

describe('payment methods and intents', () => {
  it('getPaymentMethods reads the limits from the server', async () => {
    const seen = stubFetch(() => ok(METHODS));
    const { getPaymentMethods } = await import('../payments');
    const [method] = await getPaymentMethods();
    expect(method).toMatchObject({ code: 'P2P_CARD', minTiyin: '500000', stepTiyin: '100000' });
    expect(seen[0]?.url).toBe(`${API}/payments/methods`);
  });

  it('createTopupIntent: sends the same Idempotency-Key on every attempt (the server decides a replay)', async () => {
    const seen = stubFetch(() => ok(intentCreated('uz'), 201));
    const { createTopupIntent } = await import('../payments');
    const body = { provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' } as const;
    const first = await createTopupIntent(body, TEST_IDEMPOTENCY_KEY);
    const again = await createTopupIntent(body, TEST_IDEMPOTENCY_KEY);
    expect(again.intentId).toBe(first.intentId);
    expect(seen.map((entry) => headersOf(entry)['idempotency-key'])).toEqual([
      TEST_IDEMPOTENCY_KEY,
      TEST_IDEMPOTENCY_KEY,
    ]);
    expect(headersOf(seen[0])[CSRF_HEADER]).toBe('1');
  });

  it('createTopupIntent: 422 carries the limits the form shows, never computed locally', async () => {
    const details = { min: '500000', max: '200000000', step: '100000' };
    stubFetch(() => fail(422, 'TOPUP_AMOUNT_OUT_OF_RANGE', details));
    const { createTopupIntent } = await import('../payments');
    const error = await createTopupIntent(
      { provider: 'P2P_CARD', amountTiyin: '100', purpose: 'TOPUP' },
      TEST_IDEMPOTENCY_KEY,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 422, code: 'TOPUP_AMOUNT_OUT_OF_RANGE' });
    expect(await detailsOf(error, TopupAmountOutOfRangeDetailsSchema)).toEqual(details);
  });

  it('createTopupIntent: 422 daily limit keeps its reason and a max below the minimum', async () => {
    const details = { min: '500000', max: '0', step: '100000', reason: 'DAILY_LIMIT' };
    stubFetch(() => fail(422, 'TOPUP_AMOUNT_OUT_OF_RANGE', details));
    const { createTopupIntent } = await import('../payments');
    const error = await createTopupIntent(
      { provider: 'P2P_CARD', amountTiyin: '500000', purpose: 'TOPUP' },
      TEST_IDEMPOTENCY_KEY,
    ).catch((caught: unknown) => caught);
    expect(await detailsOf(error, TopupAmountOutOfRangeDetailsSchema)).toMatchObject({
      reason: 'DAILY_LIMIT',
      max: '0',
    });
  });

  it('createTopupIntent: 409 names the request that already waits', async () => {
    stubFetch(() => fail(409, 'TOPUP_ALREADY_PENDING', { intentId: INTENT_ID }));
    const { createTopupIntent } = await import('../payments');
    const error = await createTopupIntent(
      { provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' },
      TEST_IDEMPOTENCY_KEY,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: 'TOPUP_ALREADY_PENDING' });
    expect(await detailsOf(error, TopupAlreadyPendingDetailsSchema)).toEqual({
      intentId: INTENT_ID,
    });
  });

  it('createTopupIntent: 429 gives the wait from Retry-After and is not retried by itself', async () => {
    const seen = stubFetch(() => fail(429, 'RATE_LIMITED', undefined, { 'retry-after': '120' }));
    const { createTopupIntent } = await import('../payments');
    await expect(
      createTopupIntent(
        { provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' },
        TEST_IDEMPOTENCY_KEY,
      ),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 120 });
    expect(seen).toHaveLength(1);
  });

  it('listTopupIntents sends the status and limit and reads a plain array (no meta)', async () => {
    const seen = stubFetch(() => ok([intent('PAID')]));
    const { listTopupIntents } = await import('../payments');
    const list = await listTopupIntents({ status: 'PAID', limit: 1 });
    expect(list).toHaveLength(1);
    const url = new URL(seen[0]?.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'PAID', limit: '1' });
  });

  it('getTopupIntent reads one request, and another user’s id is the 404 of the server', async () => {
    stubFetch(() => ok(intent('PENDING')));
    const { getTopupIntent } = await import('../payments');
    await expect(getTopupIntent(INTENT_ID)).resolves.toMatchObject({ status: 'PENDING' });

    stubFetch(() => fail(404, 'NOT_FOUND'));
    await expect(getTopupIntent('cm3other0000000000000000')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('cancelTopupIntent and createPayLink post an empty body to their own paths', async () => {
    const seen = stubFetch((request) =>
      request.url.endsWith('/cancel')
        ? ok({ intentId: INTENT_ID, status: 'CANCELLED' })
        : ok({
            redirectUrl: intentCreated('ru').redirectUrl,
            expiresAt: intent('PENDING').expiresAt,
          }),
    );
    const { cancelTopupIntent, createPayLink } = await import('../payments');
    await expect(cancelTopupIntent(INTENT_ID)).resolves.toEqual({
      intentId: INTENT_ID,
      status: 'CANCELLED',
    });
    const link = await createPayLink(INTENT_ID);
    expect(new URL(link.redirectUrl).search).toBe('?locale=ru');
    expect(seen.map((entry) => entry.url)).toEqual([
      `${API}/payments/intents/${INTENT_ID}/cancel`,
      `${API}/payments/intents/${INTENT_ID}/pay-link`,
    ]);
    expect(seen.map((entry) => entry.init.body)).toEqual(['{}', '{}']);
  });

  it('cancel of a request that is no longer pending is the 404 of the server', async () => {
    stubFetch(() => fail(404, 'NOT_FOUND'));
    const { cancelTopupIntent } = await import('../payments');
    await expect(cancelTopupIntent(INTENT_ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the pay view', () => {
  it('reads the view for the token, and a wrong token is a bare 404', async () => {
    stubFetch(() => ok(payView('PENDING')));
    const { getPayView } = await import('../payments');
    await expect(getPayView(INTENT_ID, PAY_TOKEN)).resolves.toMatchObject({ status: 'PENDING' });

    stubFetch(() => fail(404, 'NOT_FOUND'));
    await expect(getPayView(INTENT_ID, PAY_TOKEN)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('a 429 on the pay view keeps its Retry-After', async () => {
    stubFetch(() => fail(429, 'RATE_LIMITED', undefined, { 'retry-after': '30' }));
    const { getPayView } = await import('../payments');
    await expect(getPayView(INTENT_ID, PAY_TOKEN)).rejects.toMatchObject({
      status: 429,
      retryAfterSec: 30,
    });
  });
});
