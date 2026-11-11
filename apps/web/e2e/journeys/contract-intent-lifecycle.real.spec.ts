import {
  CancelTopupIntentResponseSchema,
  IdempotencyConflictDetailsSchema,
  PAY_TOKEN_HEADER,
  PAY_TOKEN_PATTERN,
  PayLinkResponseSchema,
  PayViewSchema,
  TopupAlreadyPendingDetailsSchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  readPayTokenFromHash,
} from '@repo/shared';
import { expect, test } from '@playwright/test';
import { errorDetails } from '../../src/lib/api/errors';
import { expectNoStore, failed, parsed, send, type Session } from '../support/real-http';
import { newPayer, setUpRealStack } from '../support/real-stack-hooks';

// Phase 7 S12-a, contract check 2 of 2: one top-up request from creation to cancellation against
// the REAL API, read with the web's envelope parser and the shared schemas (the rest of the
// endpoints: contract-wallet-methods).

test.describe.configure({ mode: 'serial' });

const stack = setUpRealStack();

const key = () => crypto.randomUUID();
const createBody = (amountTiyin: string) =>
  ({ provider: 'P2P_CARD', amountTiyin, purpose: 'TOPUP' }) as const;
const BASE = '5000000'; // 50 000 so'm

test.describe('one request, from creation to cancellation', () => {
  let payer: Session;
  let other: Session;
  let intentId: string;
  let firstToken: string;
  let payAmount: string;
  const idempotencyKey = key();

  test.beforeAll(async ({ request }) => {
    payer = await newPayer(request, 'ru');
    other = await newPayer(request);
  });

  test('POST /payments/intents: 201 with the card, the exact amount and a pay link', async ({
    request,
  }) => {
    const response = await send(request, 'POST', '/payments/intents', {
      session: payer,
      headers: { 'idempotency-key': idempotencyKey },
      body: createBody(BASE),
    });
    const { data } = parsed(response, TopupIntentCreatedSchema, 201);
    expectNoStore(response);
    intentId = data.intentId;
    payAmount = data.payAmountTiyin;

    expect(data.status).toBe('PENDING');
    expect(data.baseAmountTiyin).toBe(BASE);
    expect(data.card.bank).toBe('HUMO');
    expect(data.card.number).toBe(stack.card().pan); // the card of this run, not another
    expect(data.card.holderName).toBe('WEB E.'); // the short form: the full name never leaves
    expect(JSON.stringify(response.body)).not.toContain('HOLDER');
    const link = new URL(data.redirectUrl);
    expect(link.origin).toBe('http://localhost:3100');
    expect(link.pathname).toBe(`/pay/${intentId}`);
    // Only the language in the query (the user's own: ru); nothing secret there (D-39).
    expect(link.search).toBe('?locale=ru');
    expect(link.hash).toMatch(/^#t=/);
    firstToken = readPayTokenFromHash(link.hash) ?? '';
    expect(firstToken).toMatch(PAY_TOKEN_PATTERN);
  });

  test('a replay with the same key and body is the same request, with a new link', async ({
    request,
  }) => {
    const response = await send(request, 'POST', '/payments/intents', {
      session: payer,
      headers: { 'idempotency-key': idempotencyKey },
      body: createBody(BASE),
    });
    const { data } = parsed(response, TopupIntentCreatedSchema, 201);
    expect(data.intentId).toBe(intentId);
    expect(data.payAmountTiyin).toBe(payAmount);
    const token = readPayTokenFromHash(new URL(data.redirectUrl).hash) ?? '';
    expect(token).toMatch(PAY_TOKEN_PATTERN);
    expect(token).not.toBe(firstToken); // the old link died, as docs/04 says
    firstToken = token;
  });

  test('the same key with another body, or a new key while one waits: 409 with the request id', async ({
    request,
  }) => {
    const changed = failed(
      await send(request, 'POST', '/payments/intents', {
        session: payer,
        headers: { 'idempotency-key': idempotencyKey },
        body: createBody('6000000'),
      }),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    expect(errorDetails(changed, IdempotencyConflictDetailsSchema)).toEqual({ intentId });

    const waiting = failed(
      await send(request, 'POST', '/payments/intents', {
        session: payer,
        headers: { 'idempotency-key': key() },
        body: createBody(BASE),
      }),
      409,
      'TOPUP_ALREADY_PENDING',
    );
    expect(errorDetails(waiting, TopupAlreadyPendingDetailsSchema)).toEqual({ intentId });
  });

  test('GET /payments/intents and /:id: the owner reads it; the card shows while PENDING', async ({
    request,
  }) => {
    const one = await send(request, 'GET', `/payments/intents/${intentId}`, { session: payer });
    const { data } = parsed(one, TopupIntentSchema);
    expectNoStore(one);
    expect(data).toMatchObject({
      intentId,
      status: 'PENDING',
      payAmountTiyin: payAmount,
      paidAt: null,
      creditedTiyin: null,
    });
    expect(data.card?.number).toBe(stack.card().pan);

    const list = parsed(
      await send(request, 'GET', '/payments/intents?status=PENDING&limit=5', { session: payer }),
      TopupIntentSchema.array(),
    );
    expect(list.data.map((item) => item.intentId)).toEqual([intentId]);
    expect(list.meta).toBeUndefined();
    const paid = parsed(
      await send(request, 'GET', '/payments/intents?status=PAID', { session: payer }),
      TopupIntentSchema.array(),
    );
    expect(paid.data).toEqual([]);

    for (const query of ['status=NOPE', 'limit=101', 'limit=0', 'extra=1']) {
      failed(
        await send(request, 'GET', `/payments/intents?${query}`, { session: payer }),
        400,
        'VALIDATION_ERROR',
      );
    }
  });

  test("another user's request, and an id that does not exist, are 404 on every session route", async ({
    request,
  }) => {
    for (const [method, path] of [
      ['GET', `/payments/intents/${intentId}`],
      ['POST', `/payments/intents/${intentId}/cancel`],
      ['POST', `/payments/intents/${intentId}/pay-link`],
      ['GET', '/payments/intents/cm3nosuchintent000000000'],
      ['POST', '/payments/intents/cm3nosuchintent000000000/cancel'],
      ['POST', '/payments/intents/cm3nosuchintent000000000/pay-link'],
    ] as const) {
      failed(
        await send(request, method, path, {
          session: other,
          ...(method === 'POST' ? { body: {} } : {}),
        }),
        404,
        'NOT_FOUND',
      );
    }
    const list = parsed(
      await send(request, 'GET', '/payments/intents', { session: other }),
      TopupIntentSchema.array(),
    );
    expect(list.data).toEqual([]);
    const mine = await send(request, 'GET', `/payments/intents/${intentId}`, { session: payer });
    expect(parsed(mine, TopupIntentSchema).data.status).toBe('PENDING');
  });

  test('GET /payments/pay/:intentId: the token alone opens the view; anything else is one bare 404', async ({
    request,
  }) => {
    const view = await send(request, 'GET', `/payments/pay/${intentId}`, {
      headers: { [PAY_TOKEN_HEADER]: firstToken },
    });
    const { data } = parsed(view, PayViewSchema);
    expectNoStore(view);
    expect(view.headers['referrer-policy']).toBe('no-referrer');
    expect(data).toMatchObject({ intentId, status: 'PENDING', payAmountTiyin: payAmount });
    expect(data.card?.number).toBe(stack.card().pan);
    expect(data.ownerHint).toBe(`P***${String(payer.telegramId).slice(-1)}`);
    expect(Object.keys(view.body as object).sort()).toEqual(['data', 'success']);

    const bare = async (headers: Record<string, string>, id = intentId) => {
      const response = await send(request, 'GET', `/payments/pay/${id}`, { headers });
      failed(response, 404, 'NOT_FOUND');
      return JSON.stringify(response.body);
    };
    const wrongToken = await bare({ [PAY_TOKEN_HEADER]: 'A'.repeat(43) });
    expect(await bare({})).toBe(wrongToken);
    expect(await bare({ [PAY_TOKEN_HEADER]: 'short' })).toBe(wrongToken);
    expect(await bare({ [PAY_TOKEN_HEADER]: firstToken }, 'cm3nosuchintent000000000')).toBe(
      wrongToken,
    );
    expect(await bare({ [PAY_TOKEN_HEADER]: firstToken }, 'bad%20id')).toBe(wrongToken);
  });

  test('POST /payments/intents/:id/pay-link: a new link, and the old token dies at once', async ({
    request,
  }) => {
    const response = await send(request, 'POST', `/payments/intents/${intentId}/pay-link`, {
      session: payer,
      body: {},
    });
    const { data } = parsed(response, PayLinkResponseSchema);
    expectNoStore(response);
    const link = new URL(data.redirectUrl);
    expect(link.pathname).toBe(`/pay/${intentId}`);
    expect(link.search).toBe('?locale=ru');
    const fresh = readPayTokenFromHash(link.hash) ?? '';
    expect(fresh).toMatch(PAY_TOKEN_PATTERN);

    failed(
      await send(request, 'GET', `/payments/pay/${intentId}`, {
        headers: { [PAY_TOKEN_HEADER]: firstToken },
      }),
      404,
      'NOT_FOUND',
    );
    const view = await send(request, 'GET', `/payments/pay/${intentId}`, {
      headers: { [PAY_TOKEN_HEADER]: fresh },
    });
    expect(parsed(view, PayViewSchema).data.status).toBe('PENDING');
    firstToken = fresh;

    failed(
      await send(request, 'POST', `/payments/intents/${intentId}/pay-link`, {
        session: payer,
        body: { extra: 1 },
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  test('POST /payments/intents/:id/cancel: CANCELLED, the token dies, a second cancel is 404', async ({
    request,
  }) => {
    const response = await send(request, 'POST', `/payments/intents/${intentId}/cancel`, {
      session: payer,
      body: {},
    });
    expect(parsed(response, CancelTopupIntentResponseSchema).data).toEqual({
      intentId,
      status: 'CANCELLED',
    });
    const after = await send(request, 'GET', `/payments/intents/${intentId}`, { session: payer });
    expect(parsed(after, TopupIntentSchema).data).toMatchObject({
      status: 'CANCELLED',
      card: null, // nobody is sent to a card for a request that is over
      paidAt: null,
      creditedTiyin: null,
    });
    failed(
      await send(request, 'GET', `/payments/pay/${intentId}`, {
        headers: { [PAY_TOKEN_HEADER]: firstToken },
      }),
      404,
      'NOT_FOUND',
    );
    failed(
      await send(request, 'POST', `/payments/intents/${intentId}/cancel`, {
        session: payer,
        body: {},
      }),
      404,
      'NOT_FOUND',
    );
    failed(
      await send(request, 'POST', `/payments/intents/${intentId}/pay-link`, {
        session: payer,
        body: {},
      }),
      404,
      'NOT_FOUND',
    );
    // The same key again: the request is no longer pending, so no new link is handed out.
    const replay = failed(
      await send(request, 'POST', '/payments/intents', {
        session: payer,
        headers: { 'idempotency-key': idempotencyKey },
        body: createBody(BASE),
      }),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    expect(errorDetails(replay, IdempotencyConflictDetailsSchema)).toEqual({ intentId });
  });
});
