import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME } from './helpers';

// The waits behind sign-in and sign-out (auth-timing.ts): pinned values, the test-only override,
// and the timeout that keeps a hung sign-in request from holding the cross-tab lock.

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown): Response => json({ success: true, data });

interface Seen {
  url: string;
  init: RequestInit;
}

function timedOut(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === 'TimeoutError'
  );
}

/** A request that never answers and fails the way the browser does when its signal fires. */
function hang(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (!(signal instanceof AbortSignal)) {
      reject(new Error('no signal'));
      return;
    }
    // Built here so it is the DOMException the client checks for (not another realm's).
    const abort = () =>
      reject(new DOMException('aborted', timedOut(signal.reason) ? 'TimeoutError' : 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort);
  });
}

let restoreTiming: () => void = () => undefined;

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  restoreTiming();
  restoreTiming = () => undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pinned values', () => {
  it('a sign-in request gets 20 seconds, a logout attempt 10, a refresh 60', async () => {
    const timing = await import('../auth-timing');
    expect(timing.VERIFY_TIMEOUT_MS).toBe(20_000);
    expect(timing.LOGOUT_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    expect(timing.REFRESH_TIMEOUT_MS).toBe(60_000);
    expect(timing.authTiming()).toMatchObject({ verifyMs: 20_000 });
  });

  it('the sign-in request fits well inside the wait for the lock', async () => {
    const timing = await import('../auth-timing');
    expect(timing.VERIFY_TIMEOUT_MS).toBeLessThan(timing.LOCK_WAIT_MS);
  });
});

describe('the test-only override', () => {
  it('refuses to run in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { __setAuthTimingForTests, authTiming, REFRESH_TIMEOUT_MS } =
      await import('../auth-timing');
    expect(() => __setAuthTimingForTests({ refreshMs: 1 })).toThrow(/production/);
    expect(authTiming().refreshMs).toBe(REFRESH_TIMEOUT_MS);
  });

  it('works in tests, and the returned function restores the defaults', async () => {
    const { __setAuthTimingForTests, authTiming, VERIFY_TIMEOUT_MS } =
      await import('../auth-timing');
    const restore = __setAuthTimingForTests({ verifyMs: 5 });
    expect(authTiming().verifyMs).toBe(5);
    restore();
    expect(authTiming().verifyMs).toBe(VERIFY_TIMEOUT_MS);
  });
});

describe('verifyLogin has its own timeout', () => {
  async function load(answer: (seen: Seen) => Promise<Response>) {
    const seen: Seen[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        const entry = { url, init };
        seen.push(entry);
        return answer(entry);
      }),
    );
    const timing = await import('../auth-timing');
    restoreTiming = timing.__setAuthTimingForTests({ verifyMs: 30 });
    const auth = await import('../auth');
    return { seen, ...auth };
  }
  const body = { nonce: 'n'.repeat(43), code: '123456' };

  it('a request that never answers ends as NETWORK, and the lock is free for the next one', async () => {
    let calls = 0;
    const { seen, verifyLogin } = await load(({ init }) =>
      calls++ === 0 ? hang(init) : Promise.resolve(ok({ user: ME })),
    );
    // Web Locks semantics: one holder at a time, released when the callback settles.
    let tail: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
          const run = tail.then(callback, callback);
          tail = run.catch(() => undefined);
          return run;
        },
      },
    });

    await expect(verifyLogin(body)).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(verifyLogin(body)).resolves.toMatchObject({ user: { id: ME.id } });
    expect(seen).toHaveLength(2);
  });

  it('the caller cancelling is still a cancellation, not a network failure', async () => {
    const { verifyLogin } = await load(({ init }) => hang(init));
    const controller = new AbortController();
    const pending = verifyLogin(body, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the request carries one signal that joins the caller and the timeout', async () => {
    const { seen, verifyLogin } = await load(() => Promise.resolve(ok({ user: ME })));
    await verifyLogin(body, new AbortController().signal);
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});
