import { CSRF_HEADER } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { MOCK_RECIPIENT } from '../mock/fixtures/orders';
import { createMockTransport } from '../mock/transport';
import type { TransportRequest } from '../transport';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const API = 'http://localhost:5000/api/v1';

// Any mocked write will do: the channel rules are enforced before the route is looked up. `/quotes`
// is a mocked write that needs no idempotency key.
const QUOTE_BODY = JSON.stringify({
  productId: 'prod_stars',
  skuId: 'sku_stars_100',
  recipientToken: MOCK_RECIPIENT.recipientToken,
});

function send(request: Partial<TransportRequest> & { path: string }) {
  const transport = createMockTransport({
    apiBaseUrl: API,
    siteUrl: 'http://localhost:3100',
    getScenario: () => undefined,
    getLocale: () => 'uz',
    now: () => NOW,
  });
  const { path, ...rest } = request;
  return transport({
    method: 'POST',
    url: `${API}${path}`,
    headers: {},
    body: QUOTE_BODY,
    credentials: 'omit',
    ...rest,
  });
}

describe('mock API enforces the channel rules of the real one', () => {
  it('a cookie-channel write without the CSRF header is a 404, like the real API', async () => {
    const response = await send({ path: '/quotes', credentials: 'include' });
    expect(response.status).toBe(404);
  });

  it('a cookie-channel write with the CSRF header goes through', async () => {
    const response = await send({
      path: '/quotes',
      credentials: 'include',
      headers: { [CSRF_HEADER]: '1' },
    });
    expect(response.status).toBe(201);
  });

  it('a bearer write needs no CSRF header', async () => {
    const response = await send({
      path: '/quotes',
      credentials: 'omit',
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(201);
  });

  it('reads never need the CSRF header', async () => {
    const response = await send({
      method: 'GET',
      path: '/orders',
      credentials: 'include',
      body: undefined,
    });
    expect(response.status).toBe(200);
  });
});
