import { CSRF_HEADER, WalletResponseSchema } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCK_WAIT_MS,
  LOGOUT_ATTEMPT_TIMEOUT_MS,
  REFRESH_TIMEOUT_MS,
  __setAuthTimingForTests,
  authTiming,
  type AuthTiming,
} from '../auth-timing';
import { createWebAuth, type LockManagerLike } from '../auth-web';
import { BASE, ME, clientFor, failure, scripted, success, tick, type Script } from './helpers';

const WALLET = { balanceTiyin: '12550000', coins: '150', currency: 'UZS' };
const isRefresh = (url: string): boolean => url.endsWith('/auth/refresh');

let restoreTiming: () => void = () => undefined;
afterEach(() => restoreTiming());

function setup(
  script: Script,
  getLocks?: () => LockManagerLike | undefined,
  timing?: Partial<AuthTiming>,
) {
  if (timing !== undefined) restoreTiming = __setAuthTimingForTests(timing);
  const { transport, calls } = scripted(script);
  const onSessionLost = vi.fn();
  const auth = createWebAuth({ apiBaseUrl: BASE, transport, onSessionLost, getLocks });
  return { auth, client: clientFor(transport, auth), calls, onSessionLost };
}

describe('auth timing', () => {
  it('pins the refresh timeout at 60 s and keeps the lock wait above it', () => {
    // A shorter refresh timeout risks aborting a refresh whose rotation the server already
    // committed (then the old cookie is replayed and the session family is revoked); a lock wait
    // not longer than the refresh would give up on a tab that is still legitimately refreshing.
    expect(REFRESH_TIMEOUT_MS).toBe(60_000);
    expect(LOCK_WAIT_MS).toBeGreaterThan(REFRESH_TIMEOUT_MS);
    expect(LOGOUT_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    expect(authTiming()).toMatchObject({
      refreshMs: REFRESH_TIMEOUT_MS,
      lockWaitMs: LOCK_WAIT_MS,
      logoutAttemptMs: LOGOUT_ATTEMPT_TIMEOUT_MS,
    });
  });

  it('the test override restores the defaults', () => {
    const restore = __setAuthTimingForTests({ refreshMs: 5, lockWaitMs: 6 });
    expect(authTiming()).toMatchObject({ refreshMs: 5, lockWaitMs: 6 });
    restore();
    expect(authTiming().refreshMs).toBe(REFRESH_TIMEOUT_MS);
  });
});

const refreshCalls = (calls: { url: string }[]): number =>
  calls.filter((call) => isRefresh(call.url)).length;

describe('web channel: refresh outcomes', () => {
  it('a blocked user (refresh 403 USER_BLOCKED) loses the session', async () => {
    const { client, onSessionLost } = setup((request) =>
      isRefresh(request.url) ? failure(403, 'USER_BLOCKED') : failure(401, 'UNAUTHORIZED'),
    );
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'USER_BLOCKED',
    });
    expect(onSessionLost).toHaveBeenCalledWith(true, true);
  });

  it('any 2xx refresh renews the session, whatever its body', async () => {
    let refreshed = false;
    const { client, calls } = setup((request) => {
      if (isRefresh(request.url)) {
        refreshed = true;
        return { status: 204, retryAfter: null, body: undefined };
      }
      return refreshed ? success(WALLET) : failure(401, 'UNAUTHORIZED');
    });
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).resolves.toMatchObject(
      { currency: 'UZS' },
    );
    expect(refreshCalls(calls)).toBe(1);
  });

  it('the refresh request carries a timeout signal', async () => {
    const { client, calls } = setup((request) =>
      isRefresh(request.url) ? failure(401, 'UNAUTHORIZED') : failure(401, 'UNAUTHORIZED'),
    );
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema).catch(() => undefined);
    const refresh = calls.find((call) => isRefresh(call.url));
    expect(refresh?.signal).toBeInstanceOf(AbortSignal);
  });

  it('when the wait for the cross-tab lock times out, the answer is NETWORK and the session is kept', async () => {
    // A lock that is never granted: it only ever settles when the signal it was given fires.
    const neverGranted: LockManagerLike = {
      request: (_name, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new Error('lock wait aborted by its signal')),
          );
        }),
    };
    const { client, calls, onSessionLost } = setup(
      () => failure(401, 'UNAUTHORIZED'),
      () => neverGranted,
      { lockWaitMs: 20 },
    );
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'NETWORK',
    });
    expect(refreshCalls(calls)).toBe(0); // the refresh itself never started
    expect(onSessionLost).not.toHaveBeenCalled();
  });
});

describe('web channel: after a deliberate sign-out', () => {
  it('session-bound requests are refused in prepare, public and login ones are not', async () => {
    const { client, auth, calls, onSessionLost } = setup(() => success(WALLET));
    auth.signOut();

    for (const session of ['required', 'optional'] as const) {
      await expect(
        client.fetch({ path: '/me/wallet', session }, WalletResponseSchema),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    expect(calls).toHaveLength(0);
    expect(onSessionLost).not.toHaveBeenCalled();

    await client.fetch({ path: '/catalog/categories', session: 'anonymous' }, WalletResponseSchema);
    await client.fetch(
      { method: 'POST', path: '/auth/logout', body: {}, session: 'login' },
      WalletResponseSchema,
    );
    expect(calls.map((call) => call.credentials)).toEqual(['omit', 'include']);
    expect(calls[1]?.headers[CSRF_HEADER]).toBe('1');
  });

  it('a new sign-in lets session-bound requests out again', async () => {
    const { client, auth, calls } = setup(() => success(WALLET));
    auth.signOut();
    auth.onSignedIn?.();
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    expect(calls).toHaveLength(1);
  });
});

describe('web channel: a lost session stays lost until the next sign-in', () => {
  it('later optional requests do not refresh again, and the cleanup runs once', async () => {
    const { client, calls, onSessionLost } = setup(() => failure(401, 'UNAUTHORIZED'));

    await client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema).catch(() => 0);
    expect(refreshCalls(calls)).toBe(1);

    await client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema).catch(() => 0);
    await client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema).catch(() => 0);
    expect(refreshCalls(calls)).toBe(1);

    const firstLossFlags = onSessionLost.mock.calls.map((args: unknown[]) => args[1]);
    expect(firstLossFlags).toEqual([true, false, false]);
  });

  it('a new sign-in re-arms the refresh', async () => {
    const { client, auth, calls } = setup(() => failure(401, 'UNAUTHORIZED'));
    await client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema).catch(() => 0);
    auth.onSignedIn?.();
    await client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema).catch(() => 0);
    expect(refreshCalls(calls)).toBe(2);
  });
});

describe('web channel: after the loss', () => {
  it('a required request still tries one refresh (another tab may have signed in again)', async () => {
    let signedInElsewhere = false;
    let cookiesRenewed = false;
    const { client, calls, onSessionLost } = setup((request) => {
      if (isRefresh(request.url)) {
        cookiesRenewed = signedInElsewhere;
        return signedInElsewhere ? success({ user: ME }) : failure(401, 'UNAUTHORIZED');
      }
      return cookiesRenewed ? success(WALLET) : failure(401, 'UNAUTHORIZED');
    });

    await client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema).catch(() => 0);
    expect(refreshCalls(calls)).toBe(1);

    // Optional requests do not retry...
    await client.fetch({ path: '/me', session: 'optional' }, WalletResponseSchema).catch(() => 0);
    expect(refreshCalls(calls)).toBe(1);

    // ...a required one does, and this time the cookies are good.
    signedInElsewhere = true;
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).resolves.toMatchObject(
      { currency: 'UZS' },
    );
    expect(refreshCalls(calls)).toBe(2);

    // The session is valid again, so a later loss is a first loss again.
    signedInElsewhere = false;
    cookiesRenewed = false;
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema).catch(() => 0);
    expect(onSessionLost.mock.calls.at(-1)).toEqual([true, true]);
  });

  it('a required request that is refused again keeps the session lost', async () => {
    const { client, calls } = setup(() => failure(401, 'UNAUTHORIZED'));
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema).catch(() => 0);
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema).catch(() => 0);
    expect(refreshCalls(calls)).toBe(2);
  });
});

describe('web channel: slow refresh and the cross-tab lock', () => {
  it('a refresh that times out is "no answer": the session is kept', async () => {
    const { client, onSessionLost } = setup((request) => {
      if (isRefresh(request.url)) throw new DOMException('The operation timed out', 'TimeoutError');
      return failure(401, 'UNAUTHORIZED');
    });
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'NETWORK',
    });
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('a second tab does not start its refresh until the first tab’s refresh request has finished', async () => {
    // A mutex with the semantics of navigator.locks: requests run one after another, and the lock
    // is released when the callback's promise settles.
    let tail: Promise<unknown> = Promise.resolve();
    const locks: LockManagerLike = {
      request: (_name, _options, callback) => {
        const run = tail.then(callback, callback);
        tail = run.catch(() => undefined);
        return run;
      },
    };
    const timeline: string[] = [];
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    function tab(name: string, refreshGate: Promise<void>) {
      let renewed = false;
      const { transport } = scripted(async (request) => {
        if (isRefresh(request.url)) {
          timeline.push(`${name} refresh start`);
          await refreshGate;
          timeline.push(`${name} refresh end`);
          renewed = true;
          return success({ user: ME });
        }
        return renewed ? success(WALLET) : failure(401, 'UNAUTHORIZED');
      });
      const auth = createWebAuth({
        apiBaseUrl: BASE,
        transport,
        onSessionLost: vi.fn(),
        getLocks: () => locks,
      });
      return clientFor(transport, auth);
    }

    const tabA = tab('A', gateA);
    const tabB = tab('B', Promise.resolve());

    const first = tabA.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    await tick(); // A's refresh has started and is parked on its gate
    const second = tabB.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    await tick();
    await tick();
    // B has seen its 401 by now, but its refresh waits behind A's lock.
    expect(timeline).toEqual(['A refresh start']);

    releaseA();
    await Promise.all([first, second]);
    // A lock released before A's request finished would let "B refresh start" in earlier.
    expect(timeline).toEqual([
      'A refresh start',
      'A refresh end',
      'B refresh start',
      'B refresh end',
    ]);
  });
});
