import { QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME } from './helpers';

// Signing out, as the screens experience it: a mounted query that is still on screen, a network
// that drops the logout request, and a blocked account. The app-wide client over a stubbed fetch.

interface Seen {
  url: string;
  init: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown): Response => json({ success: true, data });
const fail = (status: number, code: string): Response =>
  json({ success: false, error: { code, message: `errors.${code}` } }, status);

type Answer = Response | Error;

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
const LOGIN = { token: 'tg-token', expiresIn: 3600, user: ME };
const WALLET = { balanceTiyin: '1', coins: '0', currency: 'UZS' };
const count = (seen: Seen[], suffix: string): number =>
  seen.filter((s) => s.url.endsWith(suffix)).length;

async function load() {
  const client = await import('../client');
  const { getQueryClient } = await import('../../query-client');
  const { qk } = await import('../../query-keys');
  const queryClient = getQueryClient();
  queryClient.setQueryData(qk.wallet.balance(), WALLET);
  return { ...client, queryClient, qk };
}

// jsdom cannot navigate; a stub location makes a redirect observable.
function stubLocation(pathname: string) {
  const assign = vi.fn();
  vi.stubGlobal('location', { pathname, search: '', assign });
  return assign;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('logout with a query still on screen', () => {
  function mountedMe(
    queryClient: import('@tanstack/react-query').QueryClient,
    qk: { me: () => readonly ['me'] },
    getMe: () => Promise<unknown>,
  ) {
    const observer = new QueryObserver(queryClient, { queryKey: qk.me(), queryFn: getMe });
    return { observer, stop: observer.subscribe(() => undefined) };
  }

  it('control: a session that is really lost does redirect to the login page', async () => {
    const assign = stubLocation('/account');
    stubFetch(() => fail(401, 'UNAUTHORIZED')); // /me and /auth/refresh
    const { queryClient, qk } = await load();
    const { getMe } = await import('../me');
    const { stop } = mountedMe(queryClient, qk, () => getMe());
    await sleep(60);
    stop();
    expect(assign).toHaveBeenCalledWith('/login?next=%2Faccount');
  });

  it('a deliberate logout neither refreshes nor redirects, and leaves no private data', async () => {
    const assign = stubLocation('/account');
    let signedOut = false;
    const seen = stubFetch(({ url }) => {
      if (url.endsWith('/auth/logout')) {
        signedOut = true;
        return ok({});
      }
      if (url.endsWith('/me')) return signedOut ? fail(401, 'UNAUTHORIZED') : ok(ME);
      return fail(401, 'UNAUTHORIZED'); // /auth/refresh would be refused too
    });
    const { queryClient, qk } = await load();
    const { getMe } = await import('../me');
    const { logout } = await import('../auth');
    const { observer, stop } = mountedMe(queryClient, qk, () => getMe());
    await sleep(40);
    expect(observer.getCurrentResult().status).toBe('success');

    await logout();
    await sleep(60); // the reset query refetches, gets its 401, and must stay quiet
    stop();

    expect(count(seen, '/auth/refresh')).toBe(0);
    expect(assign).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
    expect(observer.getCurrentResult().data).toBeUndefined();
  });

  it('after a logout, later 401s are final until the next sign-in, which re-arms the refresh', async () => {
    let signInDone = false;
    const seen = stubFetch(({ url }) => {
      if (url.endsWith('/auth/logout')) return ok({});
      if (url.endsWith('/auth/telegram/verify')) {
        signInDone = true;
        return ok({ user: ME });
      }
      if (url.endsWith('/auth/refresh'))
        return signInDone ? ok({ user: ME }) : fail(401, 'UNAUTHORIZED');
      return fail(401, 'UNAUTHORIZED');
    });
    await load();
    const { logout, verifyLogin } = await import('../auth');
    const { getMe } = await import('../me');

    await logout();
    await expect(getMe()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(getMe({ session: 'optional' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(count(seen, '/auth/refresh')).toBe(0);

    await verifyLogin({ nonce: 'n'.repeat(43), code: '123456' });
    await getMe().catch(() => 0);
    expect(count(seen, '/auth/refresh')).toBe(1);
  });

  it('Mini App: after a logout a 401 does not post the initData again', async () => {
    const seen = stubFetch(({ url }) =>
      url.endsWith('/auth/telegram/webapp') ? ok(LOGIN) : fail(401, 'UNAUTHORIZED'),
    );
    const { activateTgAuth } = await load();
    const { logout } = await import('../auth');
    const { getWallet } = await import('../me');
    const tg = activateTgAuth(() => 'query_id=AAH&hash=abc');
    await tg.login();

    await logout();
    await expect(getWallet()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(getWallet()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(count(seen, '/auth/telegram/webapp')).toBe(1);

    await tg.login(); // an explicit login is the way back
    expect(count(seen, '/auth/telegram/webapp')).toBe(2);
    expect(tg.hasToken()).toBe(true);
  });
});

describe('logout when the network drops the request', () => {
  const NETWORK = new TypeError('Failed to fetch');

  async function run(answers: Answer[]) {
    let call = 0;
    const seen = stubFetch(() => answers[call++] ?? ok({}));
    const { webAuth } = await load();
    const { __setAuthTimingForTests } = await import('../auth-timing');
    __setAuthTimingForTests({ logoutRetryDelaysMs: [0, 0] });
    const { logout } = await import('../auth');
    const signOut = vi.spyOn(webAuth, 'signOut');
    return { seen, signOut, logout };
  }

  it('NETWORK, NETWORK, 200: succeeds on the third attempt', async () => {
    const { seen, logout, signOut } = await run([NETWORK, NETWORK, ok({})]);
    await expect(logout()).resolves.toBeUndefined();
    expect(count(seen, '/auth/logout')).toBe(3);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('NETWORK three times: rejects (the cookies are still in the browser), local session still ends', async () => {
    const { seen, logout, signOut } = await run([NETWORK, NETWORK, NETWORK]);
    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(count(seen, '/auth/logout')).toBe(3);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('an HTTP error answer is final: rejects after one attempt', async () => {
    const { seen, logout, signOut } = await run([fail(500, 'INTERNAL_ERROR'), ok({})]);
    await expect(logout()).rejects.toMatchObject({ status: 500 });
    expect(count(seen, '/auth/logout')).toBe(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a 4xx answer is not retried either', async () => {
    const { seen, logout } = await run([fail(404, 'NOT_FOUND'), ok({})]);
    await expect(logout()).rejects.toMatchObject({ status: 404 });
    expect(count(seen, '/auth/logout')).toBe(1);
  });
});

describe('a blocked user, and why the session ended', () => {
  it('Mini App: later requests fail with USER_BLOCKED, not a generic UNAUTHORIZED, and do not log in again', async () => {
    let blocked = false;
    const seen = stubFetch(({ url }) => {
      if (url.endsWith('/auth/telegram/webapp')) return ok(LOGIN);
      if (!blocked) {
        blocked = true;
        return fail(403, 'USER_BLOCKED');
      }
      return fail(401, 'UNAUTHORIZED');
    });
    const { activateTgAuth } = await load();
    const { getWallet } = await import('../me');
    const tg = activateTgAuth(() => 'query_id=AAH&hash=abc');
    await tg.login();

    await expect(getWallet()).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    await expect(getWallet()).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    expect(count(seen, '/auth/telegram/webapp')).toBe(1);
    expect(tg.hasToken()).toBe(false);
  });

  it('web: later optional requests fail with USER_BLOCKED and do not refresh', async () => {
    let blocked = false;
    const seen = stubFetch(() => {
      if (!blocked) {
        blocked = true;
        return fail(403, 'USER_BLOCKED');
      }
      return fail(401, 'UNAUTHORIZED');
    });
    await load();
    const { getMe } = await import('../me');

    await expect(getMe({ session: 'optional' })).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    await expect(getMe({ session: 'optional' })).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    expect(count(seen, '/auth/refresh')).toBe(0);
  });
});
