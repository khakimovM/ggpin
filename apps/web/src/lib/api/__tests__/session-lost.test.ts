import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWebAuth } from '../auth-web';
import { qk } from '../../query-keys';
import {
  PUBLIC_QUERY_ROOTS,
  clearPrivateQueries,
  createSessionLostHandler,
  isPrivateRoot,
} from '../session-lost';
import { BASE, clientFor, failure, scripted, success } from './helpers';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Regression for the cache freeze found in review: clearing the whole QueryClient from inside a
// failing request silently cancelled queries that were still fetching, and a parallel catalog
// query stayed pending forever.
describe('losing the session with other queries in flight', () => {
  function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const navigate = vi.fn();
    const onSessionLost = createSessionLostHandler({
      getClient: () => queryClient,
      getLocation: () => ({ pathname: '/store', search: '' }),
      navigate,
    });
    const { transport, calls } = scripted(async (request) => {
      if (request.url.endsWith('/catalog/categories')) {
        await sleep(60); // still in flight when the session is lost
        return success(['stars']);
      }
      return failure(401, 'UNAUTHORIZED'); // /me and /auth/refresh
    });
    const api = clientFor(transport, createWebAuth({ apiBaseUrl: BASE, transport, onSessionLost }));
    return { queryClient, navigate, calls, api };
  }

  it('the public catalog query finishes, the private one fails, nothing stays pending', async () => {
    const { queryClient, navigate, api } = setup();
    // Private data that is cached but not on screen must be dropped.
    queryClient.setQueryData(qk.wallet.balance(), { balanceTiyin: '100' });
    queryClient.setQueryData(qk.catalog.categories('ru'), ['cached-public']);

    const catalog = new QueryObserver(queryClient, {
      queryKey: qk.catalog.categories('uz'),
      queryFn: () =>
        api.fetch({ path: '/catalog/categories', session: 'anonymous' }, z.array(z.string())),
    });
    const me = new QueryObserver(queryClient, {
      queryKey: qk.me(),
      queryFn: () => api.fetch({ path: '/me' }, z.unknown()),
    });
    const unsubscribe = [catalog.subscribe(() => undefined), me.subscribe(() => undefined)];

    await sleep(300);
    unsubscribe.forEach((stop) => stop());

    expect(catalog.getCurrentResult()).toMatchObject({
      status: 'success',
      fetchStatus: 'idle',
      data: ['stars'],
    });
    expect(me.getCurrentResult()).toMatchObject({ status: 'error', fetchStatus: 'idle' });
    expect(queryClient.getQueryData(qk.wallet.balance())).toBeUndefined();
    expect(queryClient.getQueryData(qk.catalog.categories('ru'))).toEqual(['cached-public']);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/login?next=%2Fstore');
  });

  it('does not restart a failing private query in a loop', async () => {
    const { queryClient, calls, api } = setup();
    const me = new QueryObserver(queryClient, {
      queryKey: qk.me(),
      queryFn: () => api.fetch({ path: '/me' }, z.unknown()),
    });
    const stop = me.subscribe(() => undefined);
    await sleep(300);
    stop();

    const meCalls = calls.filter((call) => call.url.endsWith('/me')).length;
    // The first attempt, plus at most the one refetch the cleanup's reset of an active query causes.
    expect(meCalls).toBeLessThanOrEqual(2);
    // A required request still tries one refresh after the loss (another tab may have signed in).
    expect(calls.filter((call) => call.url.endsWith('/auth/refresh')).length).toBeLessThanOrEqual(
      2,
    );
  });
});

describe('what counts as private', () => {
  type KeyBuilder = (...args: never[]) => readonly unknown[];

  // Every key root the registry can produce, found by walking it: a root added to `qk` shows up
  // here without anyone remembering to extend a list.
  function rootsOfRegistry(): Set<unknown> {
    const roots = new Set<unknown>();
    const visit = (node: unknown): void => {
      if (typeof node === 'function') {
        const key = (node as KeyBuilder)(...([] as never[]));
        roots.add(key[0]);
      } else if (Array.isArray(node)) {
        roots.add(node[0]);
      } else if (typeof node === 'object' && node !== null) {
        Object.values(node).forEach(visit);
      }
    };
    visit(qk);
    return roots;
  }

  it('wipes every root of the registry except the public catalog', () => {
    const roots = rootsOfRegistry();
    // A new root must be added here on purpose: the review of this list is the point.
    expect([...roots].sort()).toEqual(
      [
        'auth',
        'catalog',
        'me',
        'orders',
        'payments',
        'quote',
        'referrals',
        'sessions',
        'wallet',
      ].sort(),
    );
    for (const root of roots) {
      expect(isPrivateRoot(root), String(root)).toBe(root !== 'catalog');
    }
  });

  it('an unknown root is private by default', () => {
    expect(isPrivateRoot('something-new')).toBe(true);
    expect(PUBLIC_QUERY_ROOTS.has('catalog')).toBe(true);
  });
});

describe('clearPrivateQueries and mutations', () => {
  it('drops the results of mutations (a top-up result holds a card, an amount and a pay link)', async () => {
    const queryClient = new QueryClient();
    const mutation = new MutationObserver(queryClient, {
      mutationFn: () => Promise.resolve({ redirectUrl: 'https://site.test/pay/i#t=secret' }),
    });
    await mutation.mutate();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    clearPrivateQueries(queryClient);

    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});
