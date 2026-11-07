import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME } from './helpers';

// Another tab signed in or out: what this tab's client does (auth-remote.ts), and that this tab's
// own sign-in and sign-out tell the others (auth.ts). The app-wide client over a stubbed fetch.

interface Seen {
  url: string;
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
    vi.fn((url: string) => {
      const entry = { url };
      seen.push(entry);
      const result = answer(entry);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }),
  );
  return seen;
}

const count = (seen: Seen[], suffix: string): number =>
  seen.filter((s) => s.url.endsWith(suffix)).length;
const WALLET = { balanceTiyin: '1', coins: '0', currency: 'UZS' };

// One page, one channel object; a second object of the same name stands for another tab.
class FakeChannel {
  static open = new Set<FakeChannel>();
  private listeners = new Set<(message: MessageEvent<unknown>) => void>();
  constructor(readonly name: string) {
    FakeChannel.open.add(this);
  }
  addEventListener(_type: 'message', listener: (message: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (message: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }
  postMessage(data: unknown): void {
    for (const other of FakeChannel.open) {
      if (other === this || other.name !== this.name) continue;
      for (const listener of other.listeners) listener(new MessageEvent('message', { data }));
    }
  }
  close(): void {
    FakeChannel.open.delete(this);
  }
}

async function load() {
  const client = await import('../client');
  const { getQueryClient } = await import('../../query-client');
  const { qk } = await import('../../query-keys');
  const remote = await import('../auth-remote');
  const timing = await import('../auth-timing');
  const queryClient = getQueryClient();
  queryClient.setQueryData(qk.wallet.balance(), WALLET);
  return { ...client, ...remote, timing, queryClient, qk };
}

/** The messages other tabs would receive from this page. */
function otherTab(): unknown[] {
  const messages: unknown[] = [];
  const peer = new FakeChannel('ggpin-auth');
  peer.addEventListener('message', (message) => messages.push(message.data));
  return messages;
}

let restoreTiming: () => void = () => undefined;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('BroadcastChannel', FakeChannel);
});
afterEach(() => {
  restoreTiming();
  restoreTiming = () => undefined;
  FakeChannel.open.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a message from another tab', () => {
  it('signed-out: requests needing a session are refused locally, nothing redirects, the cache is cleared', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/store/profile', search: '', assign });
    const seen = stubFetch(() => ok(ME));
    const { applyRemoteAuthEvent, queryClient, qk } = await load();
    const { getMe } = await import('../me');

    applyRemoteAuthEvent('signed-out');

    await expect(getMe()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(getMe({ session: 'optional' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(seen).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
  });

  it('signed-in: the tab works again and what it cached belonged to the previous user', async () => {
    const seen = stubFetch(() => ok(ME));
    const { applyRemoteAuthEvent, queryClient, qk } = await load();
    const { getMe } = await import('../me');

    applyRemoteAuthEvent('signed-out');
    await expect(getMe()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    queryClient.setQueryData(qk.wallet.balance(), WALLET);

    applyRemoteAuthEvent('signed-in');

    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
    await expect(getMe()).resolves.toMatchObject({ id: ME.id });
    expect(seen).toHaveLength(1);
  });

  it('signed-in also re-arms the refresh of a tab whose session was lost', async () => {
    const seen = stubFetch(() => fail(401, 'UNAUTHORIZED'));
    const { applyRemoteAuthEvent } = await load();
    const { getMe } = await import('../me');

    await getMe({ session: 'optional' }).catch(() => undefined);
    await getMe({ session: 'optional' }).catch(() => undefined);
    expect(count(seen, '/auth/refresh')).toBe(1); // lost stays lost

    applyRemoteAuthEvent('signed-in');
    await getMe({ session: 'optional' }).catch(() => undefined);
    expect(count(seen, '/auth/refresh')).toBe(2);
  });

  it('signed-in clears a failed sign-out of this tab, so its "Chiqish amalga oshmadi" screen goes', async () => {
    const { useAuthUiStore } = await import('../../../stores/auth-ui-store');
    stubFetch(() => ok(ME));
    const { applyRemoteAuthEvent } = await load();

    useAuthUiStore.setState({ logout: 'failed' });
    applyRemoteAuthEvent('signed-in');
    expect(useAuthUiStore.getState().logout).toBe('idle');

    // A sign-out elsewhere leaves this tab's own sign-out state alone.
    useAuthUiStore.setState({ logout: 'pending' });
    applyRemoteAuthEvent('signed-out');
    expect(useAuthUiStore.getState().logout).toBe('pending');
    useAuthUiStore.setState({ logout: 'idle' });
  });

  it('the Mini App channel ignores cookie-session messages', async () => {
    stubFetch((s) =>
      s.url.endsWith('/auth/telegram/webapp')
        ? ok({ token: 't', expiresIn: 3600, user: ME })
        : ok(WALLET),
    );
    const { activateTgAuth, applyRemoteAuthEvent } = await load();
    const tg = activateTgAuth(() => 'query_id=AAH&hash=abc');
    await tg.login();

    applyRemoteAuthEvent('signed-out');

    expect(tg.hasToken()).toBe(true);
  });
});

describe('this tab tells the others', () => {
  it('a finished logout posts signed-out, after the server answered', async () => {
    stubFetch(() => ok({}));
    const messages = otherTab();
    await load();
    const { logout } = await import('../auth');

    await logout();

    expect(messages).toEqual([{ type: 'signed-out' }]);
  });

  it('a logout that got no answer posts nothing: the cookies are still there', async () => {
    stubFetch(() => new TypeError('Failed to fetch'));
    const messages = otherTab();
    const { timing } = await load();
    restoreTiming = timing.__setAuthTimingForTests({ logoutRetryDelaysMs: [0, 0] });
    const { logout } = await import('../auth');

    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK' });

    expect(messages).toEqual([]);
  });

  it('a Mini App logout posts nothing', async () => {
    stubFetch((s) =>
      s.url.endsWith('/auth/telegram/webapp')
        ? ok({ token: 't', expiresIn: 3600, user: ME })
        : ok({}),
    );
    const messages = otherTab();
    const { activateTgAuth } = await load();
    await activateTgAuth(() => 'query_id=AAH&hash=abc').login();
    const { logout } = await import('../auth');

    await logout();

    expect(messages).toEqual([]);
  });

  it('a sign-in posts signed-in once the cookies are set', async () => {
    stubFetch(() => ok({ user: ME }));
    const messages = otherTab();
    await load();
    const { verifyLogin } = await import('../auth');

    await verifyLogin({ nonce: 'n'.repeat(43), code: '123456' });

    expect(messages).toEqual([{ type: 'signed-in' }]);
  });

  it('a refused sign-in posts nothing', async () => {
    stubFetch(() => fail(422, 'CODE_INVALID'));
    const messages = otherTab();
    await load();
    const { verifyLogin } = await import('../auth');

    await expect(verifyLogin({ nonce: 'n'.repeat(43), code: '000000' })).rejects.toMatchObject({
      code: 'CODE_INVALID',
    });
    expect(messages).toEqual([]);
  });
});
