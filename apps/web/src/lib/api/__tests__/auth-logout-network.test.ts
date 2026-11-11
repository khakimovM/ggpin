import { CSRF_HEADER } from '@repo/shared';
import { QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME } from './helpers';

// What a sign-out does while its request is unanswered: the retry window, the local refusal of
// session-bound requests, and the per-attempt timeout. The app-wide client over a stubbed fetch.

interface Seen {
  url: string;
  init: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown): Response => json({ success: true, data });
const fail = (status: number, code: string): Response =>
  json({ success: false, error: { code, message: `errors.${code}` } }, status);

type Answer = Response | Error | Promise<Response>;

function stubFetch(answer: (seen: Seen) => Answer): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const entry = { url, init };
      seen.push(entry);
      const result = answer(entry);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }),
  );
  return seen;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const count = (seen: Seen[], suffix: string): number =>
  seen.filter((s) => s.url.endsWith(suffix)).length;
const NETWORK = new TypeError('Failed to fetch');

async function load() {
  const client = await import('../client');
  const { getQueryClient } = await import('../../query-client');
  const { qk } = await import('../../query-keys');
  const timing = await import('../auth-timing');
  const queryClient = getQueryClient();
  queryClient.setQueryData(qk.wallet.balance(), { balanceTiyin: '1', coins: '0', currency: 'UZS' });
  return { ...client, queryClient, qk, timing };
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

describe('a 401 that arrives while the logout is being retried', () => {
  it('neither refreshes nor redirects (the session was signed out before the first attempt)', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/account', search: '', assign });
    let releaseMe: (response: Response) => void = () => undefined;
    const pendingMe = new Promise<Response>((resolve) => {
      releaseMe = resolve;
    });
    let logoutCalls = 0;
    const seen = stubFetch(({ url }) => {
      if (url.endsWith('/auth/logout')) return logoutCalls++ === 0 ? NETWORK : ok({});
      if (url.endsWith('/me')) return pendingMe;
      return ok({ user: ME }); // /auth/refresh would succeed: the test counts it instead
    });
    const { timing } = await load();
    restoreTiming = timing.__setAuthTimingForTests({ logoutRetryDelaysMs: [80, 0] });
    const { logout } = await import('../auth');
    const { getMe } = await import('../me');

    const inFlight = getMe(); // sent before the sign-out
    const settled = inFlight.catch((e: unknown) => e);
    await sleep(5);
    const done = logout();
    await sleep(30); // the first attempt failed; the retry is waiting out its backoff
    releaseMe(fail(401, 'UNAUTHORIZED'));

    await expect(settled).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
    await done;
    expect(count(seen, '/auth/refresh')).toBe(0);
    expect(count(seen, '/auth/logout')).toBe(2);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('a logout that never got an answer', () => {
  it('keeps the local session signed out: no request needing a session reaches the network', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/account', search: '', assign });
    let signedOut = false;
    const seen = stubFetch(({ url }) => {
      if (url.endsWith('/auth/logout')) return NETWORK;
      if (url.endsWith('/auth/refresh')) return fail(401, 'UNAUTHORIZED');
      if (url.includes('/catalog/categories')) return ok([]);
      return signedOut ? fail(401, 'UNAUTHORIZED') : ok(ME);
    });
    const { queryClient, qk, timing } = await load();
    restoreTiming = timing.__setAuthTimingForTests({ logoutRetryDelaysMs: [0, 0] });
    const { logout } = await import('../auth');
    const { getMe } = await import('../me');
    const { getCategories } = await import('../catalog');
    const observer = new QueryObserver(queryClient, { queryKey: qk.me(), queryFn: () => getMe() });
    const stop = observer.subscribe(() => undefined);
    await sleep(30);
    expect(observer.getCurrentResult().data).toEqual(ME);

    signedOut = true;
    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK' });
    const afterLogout = seen.length;
    expect(count(seen, '/auth/logout')).toBe(3);

    // The retries reached the server: cookies and the CSRF header, no session handling.
    const attempts = seen.filter((s) => s.url.endsWith('/auth/logout'));
    for (const attempt of attempts) {
      expect(attempt.init.credentials).toBe('include');
      expect(new Headers(attempt.init.headers).get(CSRF_HEADER)).toBe('1');
    }

    await expect(getMe()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(getMe({ session: 'optional' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await sleep(30);
    stop();
    expect(seen.length - afterLogout).toBe(0);
    expect(count(seen, '/auth/refresh')).toBe(0);
    expect(assign).not.toHaveBeenCalled();
    // The mounted screen was reset, and the refetch it triggered could not bring the data back.
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();

    // Public reads keep working.
    await expect(getCategories('uz')).resolves.toEqual([]);
    expect(seen.length - afterLogout).toBe(1);
  });

  it('a successful sign-in ends the signed-out state', async () => {
    const seen = stubFetch(({ url }) => {
      if (url.endsWith('/auth/logout')) return NETWORK;
      if (url.endsWith('/auth/telegram/verify')) return ok({ user: ME });
      return ok(ME);
    });
    const { timing } = await load();
    restoreTiming = timing.__setAuthTimingForTests({ logoutRetryDelaysMs: [0, 0] });
    const { logout, verifyLogin } = await import('../auth');
    const { getMe } = await import('../me');

    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(getMe()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const before = seen.length;

    await verifyLogin({ nonce: 'n'.repeat(43), code: '123456' });
    await expect(getMe()).resolves.toMatchObject({ id: ME.id });
    expect(seen.length - before).toBe(2);
  });
});

describe('the timeout of one logout attempt', () => {
  /** A fetch that never answers and rejects the way the browser does when its signal fires. */
  function hang(
    init: RequestInit,
    rejectWith: (signal: AbortSignal) => DOMException,
  ): Promise<Response> {
    return new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (!(signal instanceof AbortSignal)) {
        reject(new Error('no signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(rejectWith(signal)));
    });
  }

  function stubHanging(
    rejectWith: (signal: AbortSignal) => DOMException,
    answers: (call: number) => Response | 'hang',
  ): Seen[] {
    const seen: Seen[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        seen.push({ url, init });
        const answer = answers(seen.length - 1);
        return answer === 'hang' ? hang(init, rejectWith) : Promise.resolve(answer);
      }),
    );
    return seen;
  }

  const reasons: [string, (signal: AbortSignal) => DOMException][] = [
    ['TimeoutError (AbortSignal.timeout)', () => new DOMException('timed out', 'TimeoutError')],
    ['AbortError (the setTimeout fallback)', () => new DOMException('aborted', 'AbortError')],
  ];

  it.each(reasons)('%s is no answer: the attempt is tried again', async (_name, rejectWith) => {
    const seen = stubHanging(rejectWith, (call) => (call === 0 ? 'hang' : ok({})));
    const { timing } = await load();
    restoreTiming = timing.__setAuthTimingForTests({
      logoutAttemptMs: 15,
      logoutRetryDelaysMs: [0, 0],
    });
    const { logout } = await import('../auth');

    await expect(logout()).resolves.toBeUndefined();
    expect(count(seen, '/auth/logout')).toBe(2);
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(reasons)('%s three times: rejects with NETWORK', async (_name, rejectWith) => {
    const seen = stubHanging(rejectWith, () => 'hang');
    const { timing } = await load();
    restoreTiming = timing.__setAuthTimingForTests({
      logoutAttemptMs: 15,
      logoutRetryDelaysMs: [0, 0],
    });
    const { logout } = await import('../auth');

    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(count(seen, '/auth/logout')).toBe(3);
  });

  it('ignores stray arguments: mutationFn: logout cannot change the waits', async () => {
    const seen = stubFetch(() => NETWORK);
    const { timing } = await load();
    restoreTiming = timing.__setAuthTimingForTests({ logoutRetryDelaysMs: [0, 0] });
    const { logout } = await import('../auth');
    const callWithVariables = logout as (variables: unknown) => Promise<void>;

    await expect(callWithVariables([100_000, 100_000])).rejects.toMatchObject({ code: 'NETWORK' });
    expect(count(seen, '/auth/logout')).toBe(3);
  });
});
