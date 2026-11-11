import { WalletResponseSchema } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_LOCK_NAME, type LockManagerLike } from '../auth-lock';
import { createWebAuth } from '../auth-web';
import { BASE, ME, clientFor, failure, scripted, success, tick } from './helpers';

// Sign-in and sign-out share the refresh lock (navigator.locks), so another tab's refresh and this
// tab's sign-in never overlap. "Tab A" is a web strategy with its own transport; "tab B" is the
// app-wide client over a stubbed fetch. Both see the same lock manager.

const WALLET = { balanceTiyin: '12550000', coins: '150', currency: 'UZS' };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown): Response => json({ success: true, data });

/** Requests run one after another; the lock is released when the callback's promise settles. */
function mutex(): { locks: LockManagerLike; names: string[] } {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  return {
    names,
    locks: {
      request: (name, _options, callback) => {
        names.push(name);
        const run = tail.then(callback, callback);
        tail = run.catch(() => undefined);
        return run;
      },
    },
  };
}

function installLocks(locks: LockManagerLike | undefined): void {
  vi.stubGlobal('navigator', { locks });
}

/** Tab A starts a refresh that stays parked until `release()`. */
function parkedRefreshTab(locks: LockManagerLike, timeline: string[]) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let renewed = false;
  const { transport } = scripted(async (request) => {
    if (request.url.endsWith('/auth/refresh')) {
      timeline.push('A refresh start');
      await gate;
      timeline.push('A refresh end');
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
  return { client: clientFor(transport, auth), release };
}

let restoreTiming: () => void = () => undefined;

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  restoreTiming();
  restoreTiming = () => undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sign-in and sign-out inside the refresh lock', () => {
  it('tab B’s verifyLogin does not start until tab A’s refresh has finished', async () => {
    const { locks, names } = mutex();
    installLocks(locks);
    const timeline: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        timeline.push('B verify');
        return Promise.resolve(ok({ user: ME }));
      }),
    );
    const { verifyLogin } = await import('../auth');
    const tabA = parkedRefreshTab(locks, timeline);

    const refreshing = tabA.client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    await tick();
    const verifying = verifyLogin({ nonce: 'n'.repeat(43), code: '123456' });
    await tick();
    await tick();
    expect(timeline).toEqual(['A refresh start']);

    tabA.release();
    await Promise.all([refreshing, verifying]);
    expect(timeline).toEqual(['A refresh start', 'A refresh end', 'B verify']);
    expect(names).toEqual([REFRESH_LOCK_NAME, REFRESH_LOCK_NAME]);
  });

  it('a logout waits for it too, but the local sign-out does not', async () => {
    const { locks, names } = mutex();
    installLocks(locks);
    const timeline: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        timeline.push('B logout');
        return Promise.resolve(ok({}));
      }),
    );
    const { webAuth } = await import('../client');
    const { logout } = await import('../auth');
    const signOut = vi.spyOn(webAuth, 'signOut');
    const tabA = parkedRefreshTab(locks, timeline);

    const refreshing = tabA.client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    await tick();
    const leaving = logout();
    await tick();
    await tick();
    // Waiting for the lock can take minutes; the screens must be signed out meanwhile.
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(['A refresh start']);

    tabA.release();
    await Promise.all([refreshing, leaving]);
    expect(timeline).toEqual(['A refresh start', 'A refresh end', 'B logout']);
    expect(names).toEqual([REFRESH_LOCK_NAME, REFRESH_LOCK_NAME]);
  });

  it('a lock that is not granted in time is NETWORK: nothing is sent, the logout rejects', async () => {
    const neverGranted: LockManagerLike = {
      request: (_name, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('lock wait aborted')));
        }),
    };
    installLocks(neverGranted);
    const fetchMock = vi.fn(() => Promise.resolve(ok({})));
    vi.stubGlobal('fetch', fetchMock);
    const timing = await import('../auth-timing');
    restoreTiming = timing.__setAuthTimingForTests({ lockWaitMs: 15 });
    const { logout, verifyLogin } = await import('../auth');

    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(verifyLogin({ nonce: 'n'.repeat(43), code: '123456' })).rejects.toMatchObject({
      code: 'NETWORK',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('what the request itself fails with is not turned into NETWORK', async () => {
    installLocks(mutex().locks);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json(
            { success: false, error: { code: 'CODE_INVALID', message: 'errors.CODE_INVALID' } },
            400,
          ),
        ),
      ),
    );
    const { verifyLogin } = await import('../auth');

    await expect(verifyLogin({ nonce: 'n'.repeat(43), code: '000000' })).rejects.toMatchObject({
      code: 'CODE_INVALID',
    });
  });

  it('without Web Locks both just run', async () => {
    installLocks(undefined);
    const fetchMock = vi.fn(() => Promise.resolve(ok({ user: ME })));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyLogin } = await import('../auth');

    await expect(verifyLogin({ nonce: 'n'.repeat(43), code: '123456' })).resolves.toMatchObject({
      user: { id: ME.id },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
