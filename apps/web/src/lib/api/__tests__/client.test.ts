import { CSRF_HEADER, PAY_TOKEN_HEADER } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, TEST_IDEMPOTENCY_KEY } from './helpers';
import { INTENT_ID, PAY_TOKEN, intentCreated, payView } from './payment-fixtures';

// The app-wide client, end to end through its real transport (a stubbed `fetch`), so the
// feature modules' choices (credentials, headers, channel) are checked as the browser sends them.

interface Seen {
  url: string;
  init: RequestInit;
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

const headersOf = (seen: Seen): Record<string, string> => {
  const headers = seen.init.headers;
  return typeof headers === 'object' && headers !== null ? (headers as Record<string, string>) : {};
};

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('payments API functions', () => {
  it('createTopupIntent sends the idempotency key, the CSRF header and cookies', async () => {
    const seen = stubFetch(() => envelope(intentCreated('uz'), 201));
    const { createTopupIntent } = await import('../payments');

    const created = await createTopupIntent(
      { provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' },
      TEST_IDEMPOTENCY_KEY,
    );

    expect(created.redirectUrl).toContain('#t=');
    const [request] = seen;
    expect(request?.url).toBe('http://localhost:5000/api/v1/payments/intents');
    expect(request?.init.method).toBe('POST');
    expect(request?.init.credentials).toBe('include');
    expect(request && headersOf(request)['idempotency-key']).toBe(TEST_IDEMPOTENCY_KEY);
    expect(request && headersOf(request)[CSRF_HEADER]).toBe('1');
    expect(request?.init.body).toBe(
      '{"provider":"P2P_CARD","amountTiyin":"10000000","purpose":"TOPUP"}',
    );
  });

  it('getPayView sends the capability token in X-Pay-Token only: no cookies, no referrer, token not in the URL', async () => {
    const seen = stubFetch(() => envelope(payView('PENDING')));
    const { getPayView } = await import('../payments');

    await getPayView(INTENT_ID, PAY_TOKEN);

    const [request] = seen;
    expect(request?.url).toBe(`http://localhost:5000/api/v1/payments/pay/${INTENT_ID}`);
    expect(request?.url).not.toContain(PAY_TOKEN);
    expect(request && headersOf(request)[PAY_TOKEN_HEADER]).toBe(PAY_TOKEN);
    expect(request?.init.credentials).toBe('omit');
    expect(request?.init.referrerPolicy).toBe('no-referrer');
  });

  it('getPayView refuses a malformed token locally with the same NOT_FOUND the server uses', async () => {
    const seen = stubFetch(() => envelope({}));
    const { getPayView } = await import('../payments');
    await expect(getPayView(INTENT_ID, 'short')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(seen).toHaveLength(0);
  });
});

describe('catalog', () => {
  it('is read anonymously: no cookies, cacheable', async () => {
    const seen = stubFetch(() => envelope([]));
    const { getCategories } = await import('../catalog');
    await getCategories('ru');
    expect(seen[0]?.url).toBe('http://localhost:5000/api/v1/catalog/categories?locale=ru');
    expect(seen[0]?.init.credentials).toBe('omit');
    expect(seen[0]?.init.cache).toBe('default');
  });
});

describe('mock transport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers a mocked group from fixtures without touching fetch, and leaves other groups on the network', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKS', 'orders');
    const seen = stubFetch(() => envelope(ME));
    const { getOrder } = await import('../orders');
    const { getMe } = await import('../me');

    const order = await getOrder('order_1');
    expect(order).toMatchObject({ id: 'order_1', status: 'PROCESSING' });
    expect(seen).toHaveLength(0);

    await getMe();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://localhost:5000/api/v1/me');
  });
});

describe('Mini App channel switch', () => {
  it('sends the bearer token from the webapp login instead of cookies', async () => {
    const seen = stubFetch(({ url }) =>
      url.endsWith('/auth/telegram/webapp')
        ? envelope({ token: 'tg-token', expiresIn: 3600, user: ME })
        : envelope({ balanceTiyin: '100', coins: '0', currency: 'UZS' }),
    );
    const { activateTgAuth } = await import('../client');
    const { getWallet } = await import('../me');
    const tg = activateTgAuth(() => 'query_id=AAH&hash=abc');

    await tg.login();
    await getWallet();

    const wallet = seen.find((entry) => entry.url.endsWith('/me/wallet'));
    expect(wallet && headersOf(wallet).authorization).toBe('Bearer tg-token');
    expect(wallet && headersOf(wallet)[CSRF_HEADER]).toBeUndefined();
    expect(wallet?.init.credentials).toBe('omit');
  });
});
