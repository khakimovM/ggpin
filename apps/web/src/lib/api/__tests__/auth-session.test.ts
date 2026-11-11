import { MutationObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME } from './helpers';

// The app-wide client over a stubbed `fetch`: what sign-in, sign-out and a blocked user do to the
// session and to the private data cached for it.

interface Seen {
  url: string;
  init: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown): Response => json({ success: true, data });
const fail = (status: number, code: string): Response =>
  json({ success: false, error: { code, message: `errors.${code}` } }, status);

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const LOGIN = { token: 'tg-token', expiresIn: 3600, user: ME };
const WALLET = { balanceTiyin: '1', coins: '0', currency: 'UZS' };

// Modules are re-imported per test so each one gets a fresh client and a fresh query cache.
async function load() {
  const client = await import('../client');
  const { getQueryClient } = await import('../../query-client');
  const { qk } = await import('../../query-keys');
  const queryClient = getQueryClient();
  queryClient.setQueryData(qk.wallet.balance(), WALLET);
  queryClient.setQueryData(qk.catalog.categories('uz'), ['public']);
  return { ...client, queryClient, qk };
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('logout', () => {
  it('web: calls the endpoint, then drops private data and mutation results', async () => {
    const seen = stubFetch(() => ok({}));
    const { queryClient, qk } = await load();
    const { logout } = await import('../auth');
    await new MutationObserver(queryClient, { mutationFn: () => Promise.resolve('card') }).mutate();

    await logout();

    expect(seen.map((s) => s.url)).toEqual(['http://localhost:5000/api/v1/auth/logout']);
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
    expect(queryClient.getQueryData(qk.catalog.categories('uz'))).toEqual(['public']);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('web: the local session ends even when the request fails', async () => {
    stubFetch(() => fail(500, 'INTERNAL_ERROR'));
    const { queryClient, qk, webAuth } = await load();
    const { logout } = await import('../auth');
    const signedOut = vi.spyOn(webAuth, 'signOut');

    await expect(logout()).rejects.toMatchObject({ status: 500 });

    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
  });

  it('Mini App: sends no request (the cookie-only route would answer 404) and drops the token', async () => {
    const seen = stubFetch(({ url }) =>
      url.endsWith('/auth/telegram/webapp') ? ok(LOGIN) : ok(WALLET),
    );
    const { activateTgAuth, queryClient, qk } = await load();
    const { logout } = await import('../auth');
    const tg = activateTgAuth(() => 'query_id=AAH&hash=abc');
    await tg.login();
    seen.length = 0;
    queryClient.setQueryData(qk.wallet.balance(), WALLET);

    await logout();

    expect(seen).toHaveLength(0);
    expect(tg.hasToken()).toBe(false);
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
  });
});

describe('verifyLogin', () => {
  it('drops the previous private data before the session counts as valid again', async () => {
    stubFetch(() => ok({ user: ME }));
    const { queryClient, qk, webAuth } = await load();
    const { verifyLogin } = await import('../auth');
    let cachedWhenSignedIn: unknown = 'not called';
    vi.spyOn(webAuth, 'onSignedIn').mockImplementation(() => {
      cachedWhenSignedIn = queryClient.getQueryData(qk.wallet.balance());
    });

    await verifyLogin({ nonce: 'n'.repeat(43), code: '123456' });

    expect(cachedWhenSignedIn).toBeUndefined();
    expect(queryClient.getQueryData(qk.catalog.categories('uz'))).toEqual(['public']);
  });
});

describe('Mini App activation and user change', () => {
  it('activateTgAuth drops what the web session had cached', async () => {
    stubFetch(() => ok({}));
    const { activateTgAuth, queryClient, qk } = await load();
    activateTgAuth(() => 'query_id=AAH&hash=abc');
    await sleep(20);
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
    expect(queryClient.getQueryData(qk.catalog.categories('uz'))).toEqual(['public']);
  });

  it('a login that returns another user drops the previous user’s data', async () => {
    let userId = 'user_1';
    stubFetch(() => ok({ ...LOGIN, user: { ...ME, id: userId } }));
    const { activateTgAuth, queryClient, qk } = await load();
    const tg = activateTgAuth(() => 'query_id=AAH&hash=abc');
    await tg.login();
    await sleep(20);
    queryClient.setQueryData(qk.wallet.balance(), WALLET);

    await tg.login(); // same user: nothing happens
    await sleep(20);
    expect(queryClient.getQueryData(qk.wallet.balance())).toEqual(WALLET);

    userId = 'user_2';
    await tg.login();
    await sleep(20);
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
  });
});

describe('a blocked user on an ordinary request', () => {
  it('web: ends the session, redirecting only when the request needed one', async () => {
    stubFetch(() => fail(403, 'USER_BLOCKED'));
    const { webAuth } = await load();
    const { getMe } = await import('../me');
    const lost = vi.spyOn(webAuth, 'onSessionLost');

    await expect(getMe()).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    await expect(getMe({ session: 'optional' })).rejects.toMatchObject({ code: 'USER_BLOCKED' });

    expect(lost.mock.calls.map(([redirect, reason]) => [redirect, reason?.code])).toEqual([
      [true, 'USER_BLOCKED'],
      [false, 'USER_BLOCKED'],
    ]);
  });

  it('Mini App: drops the token the same way', async () => {
    stubFetch(({ url }) =>
      url.endsWith('/auth/telegram/webapp') ? ok(LOGIN) : fail(403, 'USER_BLOCKED'),
    );
    const { activateTgAuth } = await load();
    const { getWallet } = await import('../me');
    const tg = activateTgAuth(() => 'query_id=AAH&hash=abc');
    await tg.login();
    expect(tg.hasToken()).toBe(true);

    await expect(getWallet()).rejects.toMatchObject({ code: 'USER_BLOCKED' });

    expect(tg.hasToken()).toBe(false);
  });
});

describe('on the server', () => {
  it('requests that need a session are refused without touching fetch or shared state', async () => {
    const seen = stubFetch(() => ok([]));
    const { getMe } = await import('../me');
    const { getCategories } = await import('../catalog');
    const { startLogin } = await import('../auth');
    vi.stubGlobal('window', undefined);

    await expect(getMe()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(getMe({ session: 'optional' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(startLogin()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(seen).toHaveLength(0);

    // Public reads (the SEO pages) still work.
    await expect(getCategories('uz')).resolves.toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('the Mini App channel cannot be activated there', async () => {
    const { activateTgAuth } = await import('../client');
    vi.stubGlobal('window', undefined);
    expect(() => activateTgAuth(() => null)).toThrow(/browser/);
  });
});

describe('request building', () => {
  it('a malformed Idempotency-Key is an ApiError, not a Zod error, and no request is made', async () => {
    const seen = stubFetch(() => ok({}));
    const { createTopupIntent } = await import('../payments');
    const error: unknown = await createTopupIntent(
      { provider: 'P2P_CARD', amountTiyin: '10000000', purpose: 'TOPUP' },
      'short',
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ApiError', code: 'VALIDATION_ERROR' });
    expect(String(error)).not.toContain('short');
    expect(seen).toHaveLength(0);
  });
});
