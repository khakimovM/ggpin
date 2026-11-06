import { PAY_TOKEN_HEADER } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_PAY_TOKEN, mockPayView } from '../mock/fixtures/payments';
import { ME } from './helpers';

// Same approach as client.test.ts: the real app-wide client over a stubbed `fetch`.

interface Seen {
  url: string;
  init: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown): Response => json({ success: true, data });
const fail = (status: number, code: string): Response =>
  json({ success: false, error: { code, message: `errors.${code}` } }, status);

function stubFetch(answer: (seen: Seen) => Response | Promise<Response>): Seen[] {
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

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('request hardening', () => {
  it('never follows a redirect: the transport asks fetch to reject it', async () => {
    const seen = stubFetch(() => ok([]));
    const { getCategories } = await import('../catalog');
    await getCategories('uz');
    expect(seen[0]?.init.redirect).toBe('error');
  });

  it('a redirect that fetch rejects is reported as NETWORK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { getCategories } = await import('../catalog');
    await expect(getCategories('uz')).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });

  it('the pay view is requested with no-store, a token header and nothing else sensitive', async () => {
    const seen = stubFetch(() => ok(mockPayView('PENDING', new Date())));
    const { getPayView } = await import('../payments');
    await getPayView('intent_mock_1', MOCK_PAY_TOKEN);
    expect(seen[0]?.init.cache).toBe('no-store');
    expect((seen[0]?.init.headers as Record<string, string>)[PAY_TOKEN_HEADER]).toBe(
      MOCK_PAY_TOKEN,
    );
  });

  it('session requests default to no-store; only the catalog opts in to caching', async () => {
    const seen = stubFetch(() => ok({ balanceTiyin: '1', coins: '0', currency: 'UZS' }));
    const { getWallet } = await import('../me');
    await getWallet();
    expect(seen[0]?.init.cache).toBe('no-store');
  });
});

describe('ids that become path segments', () => {
  it.each([
    ['getOrder', '../me'],
    ['getOrder', 'a/b'],
    ['getTopupIntent', 'x y'],
    ['getTopupIntent', ''],
    ['cancelTopupIntent', 'a?b=1'],
    ['createPayLink', '..'],
  ] as const)('%s(%j) is a local 404 without a request', async (name, id) => {
    const seen = stubFetch(() => ok({}));
    const orders = await import('../orders');
    const payments = await import('../payments');
    const call = {
      getOrder: () => orders.getOrder(id),
      getTopupIntent: () => payments.getTopupIntent(id),
      cancelTopupIntent: () => payments.cancelTopupIntent(id),
      createPayLink: () => payments.createPayLink(id),
    }[name];
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(seen).toHaveLength(0);
  });

  it('other path inputs are checked too: slug, session id, login nonce, pay-page intent id', async () => {
    const seen = stubFetch(() => ok({}));
    const { getProduct } = await import('../catalog');
    const { revokeSession, getLoginStatus } = await import('../auth');
    const { getPayView } = await import('../payments');
    await expect(getProduct('A B/c', 'uz')).rejects.toMatchObject({ status: 404 });
    await expect(revokeSession('a/b')).rejects.toMatchObject({ status: 404 });
    await expect(getLoginStatus('short')).rejects.toMatchObject({ status: 404 });
    await expect(getPayView('../x', MOCK_PAY_TOKEN)).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(0);
  });

  it('a well-formed id still goes through', async () => {
    const seen = stubFetch(() => fail(404, 'NOT_FOUND'));
    const { getOrder } = await import('../orders');
    await expect(getOrder('order_1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(seen[0]?.url).toBe('http://localhost:5000/api/v1/orders/order_1');
  });
});

describe('Mini App channel activation', () => {
  it('is idempotent: a second call returns the same instance and keeps its token', async () => {
    stubFetch(({ url }) =>
      url.endsWith('/auth/telegram/webapp')
        ? ok({ token: 'tg-token', expiresIn: 3600, user: ME })
        : ok({}),
    );
    const { activateTgAuth } = await import('../client');
    const first = activateTgAuth(() => 'query_id=AAH&hash=abc');
    await first.login();
    const second = activateTgAuth(() => null);
    expect(second).toBe(first);
    expect(second.hasToken()).toBe(true);
  });

  it('on /tg, requests that need a session are refused until the channel is active', async () => {
    window.history.replaceState(null, '', '/tg');
    const seen = stubFetch(() => ok({ balanceTiyin: '1', coins: '0', currency: 'UZS' }));
    const { activateTgAuth } = await import('../client');
    const { getWallet } = await import('../me');
    const { getCategories } = await import('../catalog');

    await expect(getWallet()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(seen).toHaveLength(0); // never sent over the cookie channel

    stubFetch(() => ok([]));
    await expect(getCategories('uz')).resolves.toEqual([]); // public reads are fine

    activateTgAuth(() => 'query_id=AAH&hash=abc');
    const afterActivation = stubFetch(() => ok({ balanceTiyin: '1', coins: '0', currency: 'UZS' }));
    await expect(getWallet()).resolves.toMatchObject({ currency: 'UZS' });
    expect(afterActivation).toHaveLength(1);
  });
});

describe('web sign-in re-arms a lost session', () => {
  it('verifyLogin lets optional requests refresh again', async () => {
    const seen = stubFetch(({ url }) => {
      if (url.endsWith('/auth/telegram/verify')) return ok({ user: ME });
      return fail(401, 'UNAUTHORIZED'); // /me and /auth/refresh
    });
    const { getMe } = await import('../me');
    const { verifyLogin } = await import('../auth');
    const refreshes = (): number => seen.filter((s) => s.url.endsWith('/auth/refresh')).length;

    await getMe({ session: 'optional' }).catch(() => 0);
    await getMe({ session: 'optional' }).catch(() => 0);
    expect(refreshes()).toBe(1); // lost once, then stays lost

    await verifyLogin({ nonce: 'n'.repeat(43), code: '123456' });
    await getMe({ session: 'optional' }).catch(() => 0);
    expect(refreshes()).toBe(2);
  });
});
