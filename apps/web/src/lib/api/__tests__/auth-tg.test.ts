import { CSRF_HEADER, WalletResponseSchema, type WebAppLoginResponse } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTgAuth } from '../auth-tg';
import { BASE, ME, clientFor, failure, pathOf, scripted, success, tick } from './helpers';

const WALLET = { balanceTiyin: '12550000', coins: '150', currency: 'UZS' };
const INIT_DATA = 'query_id=AAH&auth_date=1730000000&hash=abcdef';
const TOKEN = 'tg-session-token-1';
const LOGIN: WebAppLoginResponse = { token: TOKEN, expiresIn: 3600, user: ME };
const isLogin = (url: string): boolean => url.endsWith('/auth/telegram/webapp');

function setup(options: { initData?: string | null; accept?: (token: string) => boolean } = {}) {
  const { initData = INIT_DATA, accept = (token) => token === TOKEN } = options;
  const { transport, calls } = scripted((request) => {
    if (isLogin(request.url)) return success(LOGIN);
    const bearer = request.headers.authorization?.replace('Bearer ', '') ?? '';
    return accept(bearer) ? success(WALLET) : failure(401, 'UNAUTHORIZED');
  });
  const onSessionLost = vi.fn();
  const auth = createTgAuth({
    apiBaseUrl: BASE,
    transport,
    getInitData: () => initData,
    onSessionLost,
  });
  return { auth, client: clientFor(transport, auth), calls, onSessionLost };
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Mini App channel', () => {
  it('5 parallel 401s trigger exactly one re-login and every request is resent with the new token', async () => {
    const { client, calls } = setup();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.fetch({ path: '/me/wallet' }, WalletResponseSchema)),
    );

    expect(results).toHaveLength(5);
    expect(calls.filter((call) => isLogin(call.url))).toHaveLength(1);
    const resent = calls.filter((call) => pathOf(call) === '/api/v1/me/wallet').slice(5);
    expect(resent).toHaveLength(5);
    expect(resent.every((call) => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('logs in with the live initData, never with cookies', async () => {
    const { auth, calls } = setup();
    await auth.login();
    const [login] = calls;
    expect(JSON.parse(login?.body ?? '{}')).toEqual({ initData: INIT_DATA });
    expect(login?.credentials).toBe('omit');
    expect(login?.headers.authorization).toBeUndefined();
  });

  it('shares one login between concurrent explicit calls', async () => {
    const { auth, calls } = setup();
    await Promise.all([auth.login(), auth.login(), auth.login()]);
    expect(calls).toHaveLength(1);
  });

  it('keeps the token only in memory: not in localStorage, sessionStorage or cookies', async () => {
    const { auth, client } = setup();
    await auth.login();
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema);

    expect(auth.hasToken()).toBe(true);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    const everything =
      JSON.stringify({ ...window.localStorage }) +
      JSON.stringify({ ...window.sessionStorage }) +
      document.cookie;
    expect(everything).not.toContain(TOKEN);
  });

  it('sends Authorization on writes and no CSRF header (bearer requests are exempt)', async () => {
    const { auth, client, calls } = setup();
    await auth.login();
    await client.fetch({ method: 'POST', path: '/orders', body: {} }, WalletResponseSchema);

    const post = calls.find((call) => pathOf(call) === '/api/v1/orders');
    expect(post?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post?.headers[CSRF_HEADER]).toBeUndefined();
    expect(post?.credentials).toBe('omit');
  });

  it('does not attach the token to anonymous requests', async () => {
    const { auth, client, calls } = setup();
    await auth.login();
    await client
      .fetch({ path: '/catalog/categories', session: 'anonymous' }, WalletResponseSchema)
      .catch(() => undefined);
    expect(calls.at(-1)?.headers.authorization).toBeUndefined();
  });

  it('a 401 after a successful re-login is final (no loop)', async () => {
    const { client, calls } = setup({ accept: () => false });
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toHaveLength(3); // request, login, one resend
  });

  it('a 401 from a request sent before a re-login finished is resent without a second login', async () => {
    let releaseSlow: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let walletCalls = 0;
    const { transport, calls } = scripted(async (request) => {
      if (isLogin(request.url)) return success(LOGIN);
      walletCalls += 1;
      if (walletCalls === 1) {
        await gate;
        return failure(401, 'UNAUTHORIZED');
      }
      return request.headers.authorization === `Bearer ${TOKEN}`
        ? success(WALLET)
        : failure(401, 'UNAUTHORIZED');
    });
    const auth = createTgAuth({
      apiBaseUrl: BASE,
      transport,
      getInitData: () => INIT_DATA,
      onSessionLost: vi.fn(),
    });
    const client = clientFor(transport, auth);

    const slow = client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    await tick();
    await client.fetch({ path: '/me/wallet' }, WalletResponseSchema);
    releaseSlow();
    await expect(slow).resolves.toMatchObject({ currency: 'UZS' });
    expect(calls.filter((call) => isLogin(call.url))).toHaveLength(1);
  });

  it('INITDATA_EXPIRED reaches the caller and forgets the token', async () => {
    const { transport } = scripted((request) =>
      isLogin(request.url) ? failure(401, 'INITDATA_EXPIRED') : failure(401, 'UNAUTHORIZED'),
    );
    const auth = createTgAuth({
      apiBaseUrl: BASE,
      transport,
      getInitData: () => INIT_DATA,
      onSessionLost: vi.fn(),
    });
    const client = clientFor(transport, auth);
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'INITDATA_EXPIRED',
    });
    expect(auth.hasToken()).toBe(false);
  });

  it('without initData there is nothing to send: INITDATA_INVALID and no request', async () => {
    const { auth, calls } = setup({ initData: null });
    await expect(auth.login()).rejects.toMatchObject({ code: 'INITDATA_INVALID' });
    expect(calls).toHaveLength(0);
  });

  it('never asks the web login page to open', async () => {
    const { auth, onSessionLost } = setup();
    await auth.login();
    auth.onSessionLost(true);
    expect(auth.hasToken()).toBe(false);
    expect(onSessionLost).toHaveBeenCalledWith(false, true);
  });
});

describe('Mini App channel: login result and failures', () => {
  it('hands the app the user and expiry, never the bearer token', async () => {
    const { auth } = setup();
    const result = await auth.login();
    expect(Object.keys(result).sort()).toEqual(['expiresIn', 'user']);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(auth.hasToken()).toBe(true);
  });

  it('sends the CSRF header on the sign-in write, as docs/04 requires', async () => {
    const { auth, calls } = setup();
    await auth.login();
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
  });

  it('a login the server refuses reports a lost session once, until a login succeeds again', async () => {
    let refuse = true;
    const { transport } = scripted((request) => {
      if (isLogin(request.url)) return refuse ? failure(401, 'INITDATA_INVALID') : success(LOGIN);
      return success(WALLET);
    });
    const onSessionLost = vi.fn();
    const auth = createTgAuth({
      apiBaseUrl: BASE,
      transport,
      getInitData: () => INIT_DATA,
      onSessionLost,
    });

    await expect(auth.login()).rejects.toMatchObject({ code: 'INITDATA_INVALID' });
    await expect(auth.login()).rejects.toMatchObject({ code: 'INITDATA_INVALID' });
    expect(onSessionLost.mock.calls).toEqual([
      [false, true],
      [false, false],
    ]);

    refuse = false;
    await auth.login();
    refuse = true;
    await expect(auth.login()).rejects.toMatchObject({ code: 'INITDATA_INVALID' });
    expect(onSessionLost).toHaveBeenLastCalledWith(false, true);
  });

  it('a blocked user (403) also reports a lost session', async () => {
    const { transport } = scripted(() => failure(403, 'USER_BLOCKED'));
    const onSessionLost = vi.fn();
    const auth = createTgAuth({
      apiBaseUrl: BASE,
      transport,
      getInitData: () => INIT_DATA,
      onSessionLost,
    });
    await expect(auth.login()).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    expect(onSessionLost).toHaveBeenCalledWith(false, true);
  });
});
