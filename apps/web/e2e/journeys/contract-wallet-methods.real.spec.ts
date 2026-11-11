import {
  CancelTopupIntentResponseSchema,
  LedgerItemSchema,
  PAY_TOKEN_HEADER,
  PaymentMethodsResponseSchema,
  TopupAmountOutOfRangeDetailsSchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  WalletResponseSchema,
  readPayTokenFromHash,
} from '@repo/shared';
import { expect, test } from '@playwright/test';
import { errorDetails } from '../../src/lib/api/errors';
import { expectNoStore, failed, parsed, send } from '../support/real-http';
import { newPayer, setUpRealStack } from '../support/real-stack-hooks';

// Phase 7 S12-a, contract check 1 of 2: what the REAL API (phase 4, merged) answers to the wallet,
// ledger, methods and the refusals of `POST /payments/intents` (422, 400, 429), read with the
// web's own envelope parser and shared schemas. A mismatch with docs/04 shows up as a failure
// here, with the endpoint and the field. The life of one request is contract-intent-lifecycle.
// Own database and Redis DB (support/real-api.ts), bot off, worker on BANK_FEED_MODE=fake;
// nothing leaves the machine (loopback guard). The create limit is per user (5 per 10 minutes),
// so each group of requests below has its own payer.

test.describe.configure({ mode: 'serial' });

setUpRealStack();

const key = () => crypto.randomUUID();
const createBody = (amountTiyin: string) =>
  ({ provider: 'P2P_CARD', amountTiyin, purpose: 'TOPUP' }) as const;
const BASE = '5000000'; // 50 000 so'm

test('GET /me/wallet and /me/ledger: a new account has an empty wallet and an empty ledger', async ({
  request,
}) => {
  const payer = await newPayer(request);
  const wallet = await send(request, 'GET', '/me/wallet', { session: payer });
  expect(parsed(wallet, WalletResponseSchema).data).toEqual({
    balanceTiyin: '0',
    coins: '0',
    currency: 'UZS',
  });
  expectNoStore(wallet);

  const ledger = await send(request, 'GET', '/me/ledger', { session: payer });
  const page = parsed(ledger, LedgerItemSchema.array());
  expect(page.data).toEqual([]);
  expect(page.meta).toEqual({ page: 1, limit: 20, total: 0 });
  expectNoStore(ledger);
});

test('GET /me/wallet and /me/ledger: no session is 401; the ledger refuses a bad query with 400', async ({
  request,
}) => {
  failed(await send(request, 'GET', '/me/wallet'), 401, 'UNAUTHORIZED');
  failed(await send(request, 'GET', '/me/ledger'), 401, 'UNAUTHORIZED');

  const payer = await newPayer(request);
  for (const query of ['kind=NOPE', 'limit=101', 'limit=0', 'page=0', 'extra=1']) {
    failed(
      await send(request, 'GET', `/me/ledger?${query}`, { session: payer }),
      400,
      'VALIDATION_ERROR',
    );
  }
  // A known kind with no rows is an empty page, not an error.
  const page = parsed(
    await send(request, 'GET', '/me/ledger?kind=PURCHASE&limit=1', { session: payer }),
    LedgerItemSchema.array(),
  );
  expect(page.data).toEqual([]);
});

test('GET /payments/methods: the limits and the bank availability the top-up form reads', async ({
  request,
}) => {
  const payer = await newPayer(request);
  // The worker's listener writes its heartbeat every few seconds; the API reads it.
  await expect
    .poll(
      async () => {
        const response = await send(request, 'GET', '/payments/methods', { session: payer });
        return parsed(response, PaymentMethodsResponseSchema).data[0]?.available;
      },
      { timeout: 45_000, message: 'the worker listener never became alive' },
    )
    .toBe(true);

  const response = await send(request, 'GET', '/payments/methods', { session: payer });
  const [method] = parsed(response, PaymentMethodsResponseSchema).data;
  expect(method).toMatchObject({
    code: 'P2P_CARD',
    minTiyin: '500000',
    maxTiyin: '200000000',
    stepTiyin: '100000',
  });
  // Both banks are always listed; only the one with an active card is available.
  expect(method?.banks).toEqual([
    { bank: 'HUMO', available: true },
    { bank: 'UZCARD', available: false },
  ]);
  expectNoStore(response);
  failed(await send(request, 'GET', '/payments/methods'), 401, 'UNAUTHORIZED');
});

test('POST /payments/intents: 422 limits come with details; none of them is a request', async ({
  request,
}) => {
  const payer = await newPayer(request);
  const create = (amount: string) =>
    send(request, 'POST', '/payments/intents', {
      session: payer,
      headers: { 'idempotency-key': key() },
      body: createBody(amount),
    });

  const tooSmall = failed(await create('100000'), 422, 'TOPUP_AMOUNT_OUT_OF_RANGE');
  expect(errorDetails(tooSmall, TopupAmountOutOfRangeDetailsSchema)).toEqual({
    min: '500000',
    max: '200000000',
    step: '100000',
  });
  failed(await create('5050000'), 422, 'TOPUP_AMOUNT_OUT_OF_RANGE'); // off the step
  failed(await create('300000000'), 422, 'TOPUP_AMOUNT_OUT_OF_RANGE'); // over the maximum

  // A new account has the lower daily cap (500 000 so'm): the reason says which limit it was.
  const daily = failed(await create('60000000'), 422, 'TOPUP_AMOUNT_OUT_OF_RANGE');
  expect(errorDetails(daily, TopupAmountOutOfRangeDetailsSchema)).toMatchObject({
    reason: 'NEW_ACCOUNT_DAILY_LIMIT',
    min: '500000',
    step: '100000',
  });

  const none = parsed(
    await send(request, 'GET', '/payments/intents', { session: payer }),
    TopupIntentSchema.array(),
  );
  expect(none.data).toEqual([]);
  expect(none.meta).toBeUndefined(); // docs/04: a plain array, no pagination meta
});

test('POST /payments/intents: a missing, malformed key or a bad body is 400', async ({
  request,
}) => {
  const payer = await newPayer(request);
  const post = (headers: Record<string, string>, body: unknown) =>
    send(request, 'POST', '/payments/intents', { session: payer, headers, body });

  failed(await post({}, createBody(BASE)), 400, 'VALIDATION_ERROR'); // no Idempotency-Key
  failed(await post({ 'idempotency-key': 'short' }, createBody(BASE)), 400, 'VALIDATION_ERROR');
  failed(
    await post({ 'idempotency-key': key() }, { ...createBody(BASE), extra: 1 }),
    400,
    'VALIDATION_ERROR',
  );
  failed(
    await post({ 'idempotency-key': key() }, { ...createBody(BASE), purpose: 'TOPUP_AND_BUY' }),
    400,
    'VALIDATION_ERROR',
  );
  failed(
    await post({ 'idempotency-key': key() }, { ...createBody(BASE), amountTiyin: 50000.5 }),
    400,
    'VALIDATION_ERROR',
  );
});

test('a malformed id on a session route is 400, never a lookup (docs/04)', async ({ request }) => {
  const payer = await newPayer(request);
  for (const id of ['a%20b', 'x'.repeat(65)]) {
    for (const [method, path] of [
      ['GET', `/payments/intents/${id}`],
      ['POST', `/payments/intents/${id}/cancel`],
      ['POST', `/payments/intents/${id}/pay-link`],
    ] as const) {
      failed(
        await send(request, method, path, {
          session: payer,
          ...(method === 'POST' ? { body: {} } : {}),
        }),
        400,
        'VALIDATION_ERROR',
      );
    }
  }
});

test('POST /payments/intents: the sixth create in ten minutes is 429 with Retry-After', async ({
  request,
}) => {
  const payer = await newPayer(request);
  const create = () =>
    send(request, 'POST', '/payments/intents', {
      session: payer,
      headers: { 'idempotency-key': key() },
      // Refused with 422 each time: no intent is made, yet every attempt counts for the limit.
      body: createBody('100000'),
    });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    failed(await create(), 422, 'TOPUP_AMOUNT_OUT_OF_RANGE');
  }
  const limited = failed(await create(), 429, 'RATE_LIMITED');
  expect(limited.retryAfterSec).toBeGreaterThan(0);
  expect(limited.retryAfterSec).toBeLessThanOrEqual(600);
});

test('GET /payments/pay/:intentId: past 30 reads a minute for one request it is 429 with Retry-After', async ({
  request,
}) => {
  const payer = await newPayer(request);
  const made = await send(request, 'POST', '/payments/intents', {
    session: payer,
    headers: { 'idempotency-key': key() },
    body: createBody(BASE),
  });
  const { data } = parsed(made, TopupIntentCreatedSchema, 201);
  const token = readPayTokenFromHash(new URL(data.redirectUrl).hash) ?? '';

  const statuses: number[] = [];
  let limited: Awaited<ReturnType<typeof send>> | undefined;
  for (let read = 1; read <= 40 && limited === undefined; read += 1) {
    const response = await send(request, 'GET', `/payments/pay/${data.intentId}`, {
      headers: { [PAY_TOKEN_HEADER]: token },
    });
    statuses.push(response.status);
    if (response.status === 429) limited = response;
  }
  if (limited === undefined) throw new Error('40 reads in a row were never limited');
  // The limit is 30 a minute: every read before the limited one was a good 200.
  expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
  expect(statuses.length - 1).toBeLessThanOrEqual(30);
  const error = failed(limited, 429, 'RATE_LIMITED');
  expect(error.retryAfterSec).toBeGreaterThan(0);
  expect(error.retryAfterSec).toBeLessThanOrEqual(60);

  // Clean up: the request is cancelled, so it does not hold the card's amount for the next run.
  parsed(
    await send(request, 'POST', `/payments/intents/${data.intentId}/cancel`, {
      session: payer,
      body: {},
    }),
    CancelTopupIntentResponseSchema,
  );
});
