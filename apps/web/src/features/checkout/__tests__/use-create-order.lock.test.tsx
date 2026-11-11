import type { OrderDto } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiErrorCode } from '../../../lib/api/errors';
import { getAttempt, resetOrderAttempts } from '../../../lib/order-attempts';
import { useCreateOrder } from '../use-create-order';

const createOrder = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api/orders', () => ({ createOrder }));

const ORDER: OrderDto = {
  id: 'order_1',
  number: 1042,
  status: 'PAID',
  productId: 'p1',
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  skuId: null,
  quantity: 50,
  recipient: { displayName: 'Aziz', fields: { username: 'aziz_k' } },
  priceTiyin: '550000',
  discountTiyin: '0',
  totalTiyin: '550000',
  currency: 'UZS',
  createdAt: '2026-11-08T10:00:00.000Z',
  deliveredAt: null,
};

const USER = 'user_1';
const KEY = `ggpin:order-attempt:v1:${USER}`;
const LOCK = `ggpin:order-attempt:${USER}`;
const LABEL = 'Telegram Stars · 50 ⭐';
const LOST = () => new ApiError({ status: 0, code: 'NETWORK' });
const envelope = (code: ApiErrorCode, status: number) =>
  new ApiError({ status, code, fromServer: true });
const rival = () => ({
  quoteId: 'q_other',
  key: 'key-of-the-other-window',
  at: Date.now(),
  label: 'Telegram Premium',
});
const otherWindowWrites = (record: unknown) => {
  const value = JSON.stringify(record);
  window.localStorage.setItem(KEY, value);
  window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: value }));
};
const otherWindowRemoves = () => {
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
};

function setup(client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useCreateOrder(USER, 'web'), { wrapper }), client };
}

type Grant = { name: string } | null;
function installLocks(granted: boolean) {
  const names: string[] = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, _options: unknown, callback: (lock: Grant) => unknown) => {
        names.push(name);
        return Promise.resolve(callback(granted ? { name } : null));
      },
    },
  });
  return names;
}

beforeEach(() => {
  createOrder.mockReset();
  resetOrderAttempts();
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
});

describe('the cross-window lock', () => {
  it('a taken lock means a payment is on its way in another window: nothing is sent or written', async () => {
    installLocks(false);
    const { result } = setup();
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({ kind: 'busy' });
    expect(createOrder).not.toHaveBeenCalled();
    expect(getAttempt(USER)).toBeNull();
  });

  it('the busy window shows the record the other window wrote', async () => {
    installLocks(false);
    const record = rival();
    window.localStorage.setItem(KEY, JSON.stringify(record));
    const { result } = setup();
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('busy');
    expect(getAttempt(USER)).toEqual(record);
  });

  it('a granted lock is named after the user and the chain runs inside it', async () => {
    const names = installLocks(true);
    createOrder.mockResolvedValue({ order: ORDER });
    const { result } = setup();
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('ok');
    expect(names).toEqual([LOCK]);
  });

  it('the slot is read FRESH from storage inside the lock: a record only storage has blocks another quote', async () => {
    installLocks(true);
    const { result } = setup();
    getAttempt(USER); // the module cache has seen "no record"
    window.localStorage.setItem(KEY, JSON.stringify(rival())); // and no event was delivered
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'uncertain',
      quoteId: 'q_other',
    });
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe('without Web Locks: the write is read back', () => {
  it('another window that wrote at the same instant wins; nothing is sent from here', async () => {
    const other = rival();
    const realSet = Storage.prototype.setItem.bind(window.localStorage);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((name, value) => {
      realSet(name, value);
      realSet(name, JSON.stringify(other));
    });
    try {
      const { result } = setup();
      expect(navigator.locks).toBeUndefined();
      expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
        kind: 'uncertain',
        quoteId: 'q_other',
      });
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the doubt outlives a check that settled nothing', () => {
  async function inDoubt() {
    createOrder.mockRejectedValueOnce(LOST());
    const view = setup();
    await act(() => view.result.current.pay('quote_a', LABEL));
    return { ...view, before: getAttempt(USER) };
  }

  it('another window removed the record while this check was running: it is written back', async () => {
    const { result, before } = await inDoubt();
    createOrder.mockImplementationOnce(() => {
      otherWindowRemoves(); // tab A got a clear refusal for its own first send
      return Promise.reject(LOST());
    });
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('uncertain');
    expect(getAttempt(USER)).toEqual(before);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  it('also for a refusal that proves nothing (a 429 during a check)', async () => {
    const { result } = await inDoubt();
    createOrder.mockImplementationOnce(() => {
      otherWindowRemoves();
      return Promise.reject(envelope('RATE_LIMITED', 429));
    });
    await act(() => result.current.pay('quote_a', LABEL));
    expect(getAttempt(USER)?.quoteId).toBe('quote_a');
  });

  it('another window already holds a record of ANOTHER quote: it is never overwritten', async () => {
    const { result } = await inDoubt();
    const other = rival();
    createOrder.mockImplementationOnce(() => {
      otherWindowWrites(other);
      return Promise.reject(LOST());
    });
    await act(() => result.current.pay('quote_a', LABEL));
    expect(getAttempt(USER)).toEqual(other);
  });

  it('a resolved check does NOT bring the record back', async () => {
    const { result } = await inDoubt();
    createOrder.mockRejectedValueOnce(envelope('QUOTE_EXPIRED', 410));
    await act(() => result.current.pay('quote_a', LABEL));
    expect(getAttempt(USER)).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('a refetch that hangs does not hold the paid order back', () => {
  it('the answer is the 201 even if invalidateQueries never settles', async () => {
    createOrder.mockResolvedValue({ order: ORDER });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi
      .spyOn(client, 'invalidateQueries')
      .mockReturnValue(new Promise(() => undefined));
    const { result } = setup(client);
    await expect(act(() => result.current.pay('quote_a', LABEL))).resolves.toEqual({
      kind: 'ok',
      orderId: 'order_1',
    });
    expect(getAttempt(USER)).toBeNull();
    expect(invalidate).toHaveBeenCalled();
  });
});
