import { WalletResponseSchema, type WebAppLoginResponse } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTgAuth } from '../auth-tg';
import { BASE, ME, clientFor, failure, scripted, success } from './helpers';

const WALLET = { balanceTiyin: '12550000', coins: '150', currency: 'UZS' };
const INIT_DATA = 'query_id=AAH&auth_date=1730000000&hash=abcdef';
const TOKEN = 'tg-session-token-1';
const LOGIN: WebAppLoginResponse = { token: TOKEN, expiresIn: 3600, user: ME };
const isLogin = (url: string): boolean => url.endsWith('/auth/telegram/webapp');

describe('Mini App channel: after a refused login', () => {
  it('a 401 does not post the initData again (that would turn INITDATA_EXPIRED into RATE_LIMITED)', async () => {
    const { transport, calls } = scripted((request) =>
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
    const logins = (): number => calls.filter((call) => isLogin(call.url)).length;
    expect(logins()).toBe(1);

    // Further requests fail at once with the same reason, without another login attempt.
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'INITDATA_EXPIRED',
    });
    await expect(client.fetch({ path: '/me/orders' }, WalletResponseSchema)).rejects.toMatchObject({
      code: 'INITDATA_EXPIRED',
    });
    expect(logins()).toBe(1);
  });

  it('an explicit login (gate retry) is the way out, and then requests work again', async () => {
    let initDataFresh = false;
    const { transport } = scripted((request) => {
      if (isLogin(request.url))
        return initDataFresh ? success(LOGIN) : failure(401, 'INITDATA_EXPIRED');
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

    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).rejects.toBeDefined();
    initDataFresh = true;
    await auth.login();
    await expect(client.fetch({ path: '/me/wallet' }, WalletResponseSchema)).resolves.toMatchObject(
      { currency: 'UZS' },
    );
  });
});

describe('Mini App channel: a different user', () => {
  function withUsers(ids: string[]) {
    let next = 0;
    const { transport } = scripted(() =>
      success({ token: TOKEN, expiresIn: 3600, user: { ...ME, id: ids[next++] ?? 'x' } }),
    );
    const onUserChanged = vi.fn();
    const auth = createTgAuth({
      apiBaseUrl: BASE,
      transport,
      getInitData: () => INIT_DATA,
      onSessionLost: vi.fn(),
      onUserChanged,
    });
    return { auth, onUserChanged };
  }

  it('tells the app when a login returns another user than before', async () => {
    const { auth, onUserChanged } = withUsers(['user_1', 'user_1', 'user_2']);
    await auth.login();
    expect(onUserChanged).not.toHaveBeenCalled(); // the first user is not a change
    await auth.login();
    expect(onUserChanged).not.toHaveBeenCalled(); // same user again
    await auth.login();
    expect(onUserChanged).toHaveBeenCalledTimes(1); // another user: cached data is theirs
  });
});
