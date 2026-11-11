import { CSRF_HEADER, WalletResponseSchema } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { createWebAuth, REFRESH_LOCK_NAME, type LockManagerLike } from '../auth-web';
import { ApiError } from '../errors';
import {
  BASE,
  ME,
  TEST_IDEMPOTENCY_KEY,
  clientFor,
  failure,
  pathOf,
  scripted,
  success,
  tick,
} from './helpers';

const WALLET = { balanceTiyin: '12550000', coins: '150', currency: 'UZS' };
const isRefresh = (url: string): boolean => url.endsWith('/auth/refresh');

function setup(
  script: Parameters<typeof scripted>[0],
  getLocks?: () => LockManagerLike | undefined,
) {
  const { transport, calls } = scripted(script);
  const onSessionLost = vi.fn();
  const auth = createWebAuth({ apiBaseUrl: BASE, transport, onSessionLost, getLocks });
  return { client: clientFor(transport, auth), calls, onSessionLost, auth };
}

const refreshCalls = (calls: { url: string }[]): number =>
  calls.filter((call) => isRefresh(call.url)).length;

describe('web channel: refresh on 401', () => {
  it('5 parallel 401s trigger exactly one refresh and every request is resent once', async () => {
    let refreshed = false;
    const { client, calls, onSessionLost } = setup(async (request) => {
      if (isRefresh(request.url)) {
        await tick();
        refreshed = true;
        return success({ user: ME });
      }
      return refreshed ? success(WALLET) : failure(401, 'UNAUTHORIZED');
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.fetch({ path: '/me/wallet' }, WalletResponseSchema)),
    );

    expect(results).toHaveLength(5);
    expect(refreshCalls(calls)).toBe(1);
    expect(calls.filter((call) => pathOf(call) === '/api/v1/me/wallet')).toHaveLength(10);
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('a 401 that arrives after somebody else already refreshed is resent without a second refresh', async () => {
    let refreshed = false;
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let walletCalls = 0;
    const { client, calls } = setup(async (request) => {
      if (isRefresh(request.url)) {
        refreshed = true;
        return success({ user: ME });
      }
      walletCalls += 1;
      // The first request was sent with the old cookie and its 401 comes back late.
      if (walletCalls === 1) {
        await slowGate;
        return failure(401, 'UNAUTHORIZED');
      }
      return refreshed ? success(WALLET) : failure(401, 'UNAUTHORIZED');
    });

    const slow = client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    await tick();
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema); // refreshes once
    releaseSlow();
    await expect(slow).resolves.toMatchObject({ currency: 'UZS' });

    expect(refreshCalls(calls)).toBe(1);
  });

  it('serialises the refresh through navigator.locks when it exists', async () => {
    let refreshed = false;
    const lockNames: string[] = [];
    const locks: LockManagerLike = {
      request: (name, _options, callback) => {
        lockNames.push(name);
        return callback();
      },
    };
    const { client } = setup(
      (req) => {
        if (isRefresh(req.url)) {
          refreshed = true;
          return success({ user: ME });
        }
        return refreshed ? success(WALLET) : failure(401, 'UNAUTHORIZED');
      },
      () => locks,
    );

    await Promise.all([
      client.fetch({ path: '/me/wallet' }, WalletResponseSchema),
      client.fetch({ path: '/me/wallet' }, WalletResponseSchema),
    ]);

    expect(lockNames).toEqual([REFRESH_LOCK_NAME]);
  });

  it('TOKEN_REUSE_DETECTED on refresh clears the session, redirects and does not resend', async () => {
    const { client, calls, onSessionLost } = setup((request) =>
      isRefresh(request.url) ? failure(401, 'TOKEN_REUSE_DETECTED') : failure(401, 'UNAUTHORIZED'),
    );

    const error: unknown = await client
      .fetch({ path: '/me/wallet' }, WalletResponseSchema)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'TOKEN_REUSE_DETECTED', status: 401 });
    expect(onSessionLost).toHaveBeenCalledWith(true, true);
    // The original request plus the refresh: no second attempt of the original.
    expect(calls).toHaveLength(2);
  });

  it('TOKEN_REUSE_DETECTED on an ordinary request also ends the session without a refresh', async () => {
    const { client, calls, onSessionLost } = setup(() => failure(401, 'TOKEN_REUSE_DETECTED'));
    await expect(client.fetch({ path: '/me' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'TOKEN_REUSE_DETECTED',
    });
    expect(calls).toHaveLength(1);
    expect(onSessionLost).toHaveBeenCalledWith(true, true);
  });

  it('a refresh refused with 401 UNAUTHORIZED ends the session', async () => {
    const { client, onSessionLost } = setup(() => failure(401, 'UNAUTHORIZED'));
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(onSessionLost).toHaveBeenCalledWith(true, true);
  });

  it('an optional session reports the loss without asking for a redirect', async () => {
    const { client, onSessionLost } = setup(() => failure(401, 'UNAUTHORIZED'));
    await expect(
      client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(onSessionLost).toHaveBeenCalledWith(false, true);
  });

  it('keeps the session when the refresh itself cannot be reached', async () => {
    const { client, onSessionLost } = setup((request) => {
      if (isRefresh(request.url)) throw new TypeError('Failed to fetch');
      return failure(401, 'UNAUTHORIZED');
    });
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
    });
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('keeps the session on a refresh 5xx', async () => {
    const { client, onSessionLost } = setup((request) =>
      isRefresh(request.url) ? failure(503, 'INTERNAL_ERROR') : failure(401, 'UNAUTHORIZED'),
    );
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      status: 503,
    });
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('does not loop: a 401 after a successful refresh is final', async () => {
    const { client, calls } = setup((request) =>
      isRefresh(request.url) ? success({ user: ME }) : failure(401, 'UNAUTHORIZED'),
    );
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toHaveLength(3); // request, refresh, one resend
  });

  it('never refreshes for the sign-in routes or for anonymous requests', async () => {
    const { client, calls } = setup(() => failure(401, 'UNAUTHORIZED'));
    await expect(
      client.fetch(
        { path: '/auth/telegram/verify', method: 'POST', body: {}, session: 'login' },
        WalletResponseSchema,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.fetch({ path: '/catalog/categories', session: 'anonymous' }, WalletResponseSchema),
    ).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls(calls)).toBe(0);
  });
});

describe('web channel: request headers', () => {
  it('sends the CSRF header and cookies on writes, only cookies on reads', async () => {
    const { client, calls } = setup(() => success(WALLET));
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    await client.fetch({ method: 'POST', path: '/orders', body: {} }, WalletResponseSchema);
    await client.fetch({ method: 'DELETE', path: '/auth/sessions/s1' }, WalletResponseSchema);

    const [read, post, del] = calls;
    expect(read?.headers[CSRF_HEADER]).toBeUndefined();
    expect(post?.headers[CSRF_HEADER]).toBe('1');
    expect(del?.headers[CSRF_HEADER]).toBe('1');
    expect([read, post, del].map((call) => call?.credentials)).toEqual([
      'include',
      'include',
      'include',
    ]);
    // Cookie auth: the client never builds an Authorization header.
    expect(post?.headers.authorization).toBeUndefined();
  });

  it('keeps cookies off anonymous reads and out of the HTTP cache for session reads', async () => {
    const { client, calls } = setup(() => success(WALLET));
    await client.fetch({ path: '/catalog/categories', session: 'anonymous' }, WalletResponseSchema);
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    expect(calls[0]?.credentials).toBe('omit');
    expect(calls[1]?.cache).toBe('no-store');
  });

  it('sends the Idempotency-Key and serialises the query without undefined values', async () => {
    const { client, calls } = setup(() => success(WALLET));
    await client.fetch(
      {
        method: 'POST',
        path: '/orders',
        body: { quoteId: 'q1' },
        idempotencyKey: TEST_IDEMPOTENCY_KEY,
        query: { page: 2, kind: undefined, status: ['PAID', 'QUEUED'] },
      },
      WalletResponseSchema,
    );
    const call = calls[0];
    expect(call?.headers['idempotency-key']).toBe(TEST_IDEMPOTENCY_KEY);
    expect(call?.url).toBe(`${BASE}/orders?page=2&status=PAID%2CQUEUED`);
    expect(call?.body).toBe('{"quoteId":"q1"}');
  });

  it('rejects a malformed Idempotency-Key before any request is made', async () => {
    const { client, calls } = setup(() => success(WALLET));
    await expect(
      client.fetch(
        { method: 'POST', path: '/orders', idempotencyKey: 'short' },
        WalletResponseSchema,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
