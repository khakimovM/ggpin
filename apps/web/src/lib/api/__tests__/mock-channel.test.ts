import {
  CSRF_HEADER,
  PayLinkResponseSchema,
  TopupIntentCreatedSchema,
  type Locale,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { parseResponse } from '../envelope';
import { createMockTransport } from '../mock/transport';
import type { TransportRequest } from '../transport';
import { TEST_IDEMPOTENCY_KEY } from './helpers';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const API = 'http://localhost:5000/api/v1';

function send(request: Partial<TransportRequest> & { path: string }, locale: Locale = 'uz') {
  const transport = createMockTransport({
    apiBaseUrl: API,
    siteUrl: 'http://localhost:3100',
    getScenario: () => undefined,
    getLocale: () => locale,
    now: () => NOW,
  });
  const { path, ...rest } = request;
  return transport({
    method: 'POST',
    url: `${API}${path}`,
    headers: {},
    body: '{}',
    credentials: 'omit',
    ...rest,
  });
}

describe('mock API enforces the channel rules of the real one', () => {
  it('a cookie-channel write without the CSRF header is a 404, like the real API', async () => {
    const response = await send({
      path: '/payments/intents/intent_mock_1/cancel',
      credentials: 'include',
    });
    expect(response.status).toBe(404);
  });

  it('a cookie-channel write with the CSRF header goes through', async () => {
    const response = await send({
      path: '/payments/intents/intent_mock_1/cancel',
      credentials: 'include',
      headers: { [CSRF_HEADER]: '1' },
    });
    expect(response.status).toBe(200);
  });

  it('a bearer write needs no CSRF header', async () => {
    const response = await send({
      path: '/payments/intents/intent_mock_1/cancel',
      credentials: 'omit',
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(200);
  });

  it('reads never need the CSRF header', async () => {
    const response = await send({
      method: 'GET',
      path: '/payments/methods',
      credentials: 'include',
      body: undefined,
    });
    expect(response.status).toBe(200);
  });
});

describe('mock pay links follow the page language', () => {
  it.each(['uz', 'ru'] as const)('pay-link in %s', async (locale) => {
    const response = await send({ path: '/payments/intents/intent_mock_1/pay-link' }, locale);
    const { data } = parseResponse(response, PayLinkResponseSchema, NOW.getTime());
    expect(new URL(data.redirectUrl).search).toBe(`?locale=${locale}`);
  });

  it.each(['uz', 'ru'] as const)('a created intent links to the %s pay page', async (locale) => {
    const response = await send(
      {
        path: '/payments/intents',
        headers: { 'idempotency-key': TEST_IDEMPOTENCY_KEY },
        body: JSON.stringify({ provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' }),
      },
      locale,
    );
    const { data } = parseResponse(response, TopupIntentCreatedSchema, NOW.getTime());
    expect(new URL(data.redirectUrl).search).toBe(`?locale=${locale}`);
  });
});
