import {
  CreateQuoteBodySchema,
  OrderDetailSchema,
  OrderSchema,
  QuoteResponseSchema,
  ValidateRecipientResponseSchema,
  type Locale,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseResponse } from '../envelope';
import { TEST_IDEMPOTENCY_KEY } from './helpers';
import { MOCK_RECIPIENT } from '../mock/fixtures/orders';
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
