import {
  CancelTopupIntentResponseSchema,
  CreateQuoteBodySchema,
  IntentListQuerySchema,
  LedgerItemSchema,
  OrderDetailSchema,
  OrderSchema,
  PayLinkResponseSchema,
  PAY_TOKEN_HEADER,
  PayLinkUrlSchema,
  PayViewSchema,
  PaymentMethodsResponseSchema,
  QuoteResponseSchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  ValidateRecipientResponseSchema,
  WalletResponseSchema,
  type Locale,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseResponse } from '../envelope';
import { TEST_IDEMPOTENCY_KEY } from './helpers';
import { MOCK_PAY_TOKEN } from '../mock/fixtures/payments';
import { MOCK_RECIPIENT } from '../mock/fixtures/orders';
import { MOCK_WALLET, MOCK_WALLET_LOW } from '../mock/fixtures/wallet';
import type { MockScenario } from '../mock/router';
import { createMockTransport } from '../mock/transport';
import type { HttpMethod } from '../transport';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const API = 'http://localhost:5000/api/v1';
const SITE = 'http://localhost:3100';

interface Call {
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  scenario?: MockScenario;
  locale?: Locale;
  credentials?: 'include' | 'omit';
}

async function call({
  method,
  path,
  body,
  headers = {},
  scenario,
  locale = 'uz',
  credentials = 'omit',
}: Call) {
  const transport = createMockTransport({
    apiBaseUrl: API,
    siteUrl: SITE,
    getScenario: () => scenario,
    getLocale: () => locale,
    now: () => NOW,
  });
  return transport({
    method,
    url: `${API}${path}`,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials,
  });
}

describe('mock handlers answer in the real contract shape', () => {
  const valid = <S extends z.ZodType>(response: Awaited<ReturnType<typeof call>>, schema: S) =>
    parseResponse(response, schema, NOW.getTime());

  it('wallet and ledger', async () => {
    expect(
      valid(await call({ method: 'GET', path: '/me/wallet' }), WalletResponseSchema).data
        .balanceTiyin,
    ).toBe(MOCK_WALLET.balanceTiyin);
    expect(
      valid(
        await call({ method: 'GET', path: '/me/wallet', scenario: 'insufficient' }),
        WalletResponseSchema,
      ).data.balanceTiyin,
    ).toBe(MOCK_WALLET_LOW.balanceTiyin);

    const ledger = valid(
      await call({ method: 'GET', path: '/me/ledger?limit=2' }),
      LedgerItemSchema.array(),
    );
    expect(ledger.data).toHaveLength(2);
    expect(ledger.meta).toEqual({ page: 1, limit: 2, total: 4 });
    const purchases = valid(
      await call({ method: 'GET', path: '/me/ledger?kind=PURCHASE' }),
      LedgerItemSchema.array(),
    );
    expect(purchases.data.map((entry) => entry.kind)).toEqual(['PURCHASE']);
  });

  it('order list: filtered by a group of statuses and cut into pages', async () => {
    const all = valid(await call({ method: 'GET', path: '/orders' }), OrderSchema.array());
    expect(all.data).toHaveLength(20);
    expect(all.meta).toEqual({ page: 1, limit: 20, total: 25 });
    const second = valid(
      await call({ method: 'GET', path: '/orders?page=2' }),
      OrderSchema.array(),
    );
    expect(second.data).toHaveLength(5);
    const done = valid(
      await call({ method: 'GET', path: '/orders?status=DELIVERED' }),
      OrderSchema.array(),
    );
    expect(done.data.length).toBeGreaterThan(0);
    expect(done.data.every((order) => order.status === 'DELIVERED')).toBe(true);
    const cancelled = valid(
      await call({ method: 'GET', path: '/orders?status=FAILED,REFUNDED,CANCELLED' }),
      OrderSchema.array(),
    );
    expect(cancelled.data.length).toBeGreaterThan(0);
    expect(
      cancelled.data.every((order) => ['FAILED', 'REFUNDED', 'CANCELLED'].includes(order.status)),
    ).toBe(true);
    const bad = await call({ method: 'GET', path: '/orders?status=NOPE' });
    expect(bad.status).toBe(400);
  });

  it('payments: methods, create, read, cancel, pay-link, pay view', async () => {
    valid(await call({ method: 'GET', path: '/payments/methods' }), PaymentMethodsResponseSchema);

    const created = valid(
      await call({
        method: 'POST',
        path: '/payments/intents',
        headers: { 'idempotency-key': TEST_IDEMPOTENCY_KEY },
        body: { provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' },
      }),
      TopupIntentCreatedSchema,
    );
    expect(created.data.baseAmountTiyin).toBe('10000000');
    expect(created.data.payAmountTiyin).toBe('10037700');

    valid(
      await call({ method: 'GET', path: '/payments/intents/intent_mock_1' }),
      TopupIntentSchema,
    );
    const list = valid(
      await call({ method: 'GET', path: '/payments/intents' }),
      TopupIntentSchema.array(),
    );
    // docs/04: a plain array, no pagination meta.
    expect(list.meta).toBeUndefined();
    expect(list.data).toHaveLength(1);
    const none = valid(
      await call({ method: 'GET', path: '/payments/intents?status=PAID' }),
      TopupIntentSchema.array(),
    );
    expect(none.data).toEqual([]);
    const capped = valid(
      await call({ method: 'GET', path: '/payments/intents?limit=1' }),
      TopupIntentSchema.array(),
    );
    expect(capped.data).toHaveLength(1);
    expect(() => IntentListQuerySchema.parse({})).not.toThrow();
    valid(
      await call({ method: 'POST', path: '/payments/intents/intent_mock_1/cancel', body: {} }),
      CancelTopupIntentResponseSchema,
    );
    const link = valid(
      await call({ method: 'POST', path: '/payments/intents/intent_mock_1/pay-link', body: {} }),
      PayLinkResponseSchema,
    );
    expect(() => PayLinkUrlSchema.parse(link.data.redirectUrl)).not.toThrow();

    const view = await call({
      method: 'GET',
      path: '/payments/pay/intent_mock_1',
      headers: { [PAY_TOKEN_HEADER]: MOCK_PAY_TOKEN },
    });
    expect(valid(view, PayViewSchema).data.status).toBe('PENDING');
  });

  it('a pay view without the right token is a bare 404', async () => {
    const response = await call({
      method: 'GET',
      path: '/payments/pay/intent_mock_1',
      headers: { [PAY_TOKEN_HEADER]: 'wrong' },
    });
    expect(response.status).toBe(404);
  });

  it('create intent rejects a missing key, a bad body and an amount outside the limits', async () => {
    const body = { provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' };
    const headers = { 'idempotency-key': TEST_IDEMPOTENCY_KEY };
    expect((await call({ method: 'POST', path: '/payments/intents', body })).status).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          path: '/payments/intents',
          headers,
          body: { ...body, extra: 1 },
        })
      ).status,
    ).toBe(400);
    const low = await call({
      method: 'POST',
      path: '/payments/intents',
      headers,
      body: { ...body, amountTiyin: '100' },
    });
    expect(low.status).toBe(422);
    expect(low.body).toMatchObject({
      error: { code: 'TOPUP_AMOUNT_OUT_OF_RANGE', details: { min: '500000' } },
    });
  });

  it('the expired scenario turns the intent EXPIRED', async () => {
    const response = await call({
      method: 'GET',
      path: '/payments/intents/intent_mock_1',
      scenario: 'intentExpired',
    });
    const intent = valid(response, TopupIntentSchema).data;
    expect(intent.status).toBe('EXPIRED');
    expect(intent.card).toBeNull();
  });

  it('recipient, quote and order, including their failure scenarios', async () => {
    const recipientBody = { productId: 'prod_stars', input: { username: 'test_user_1' } };
    valid(
      await call({ method: 'POST', path: '/recipients/validate', body: recipientBody }),
      ValidateRecipientResponseSchema,
    );
    expect(
      (
        await call({
          method: 'POST',
          path: '/recipients/validate',
          body: recipientBody,
          scenario: 'recipientNotFound',
        })
      ).status,
    ).toBe(422);

    const quoteBody = {
      productId: 'prod_stars',
      skuId: 'sku_stars_100',
      recipientToken: MOCK_RECIPIENT.recipientToken,
    };
    expect(() => CreateQuoteBodySchema.parse(quoteBody)).not.toThrow();
    valid(await call({ method: 'POST', path: '/quotes', body: quoteBody }), QuoteResponseSchema);
    const unavailable = await call({
      method: 'POST',
      path: '/quotes',
      body: quoteBody,
      scenario: 'priceUnavailable',
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ error: { code: 'PRICE_UNAVAILABLE' } });

    const headers = { 'idempotency-key': TEST_IDEMPOTENCY_KEY };
    const created = await call({
      method: 'POST',
      path: '/orders',
      headers,
      body: { quoteId: 'quote_mock_1' },
    });
    expect(created.status).toBe(201);
    const short = await call({
      method: 'POST',
      path: '/orders',
      headers,
      body: { quoteId: 'quote_mock_1' },
      scenario: 'insufficient',
    });
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({
      error: {
        code: 'INSUFFICIENT_BALANCE',
        details: { balance: '1000000', required: '8540000', shortfall: '7540000' },
      },
    });

    const failed = await call({
      method: 'GET',
      path: '/orders/order_mock_1',
      scenario: 'orderFailed',
    });
    expect(valid(failed, OrderDetailSchema).data.status).toBe('FAILED');
  });

  it('an unknown route is a 404 envelope', async () => {
    const response = await call({ method: 'GET', path: '/nope' });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: 'errors.NOT_FOUND' },
    });
  });
});
