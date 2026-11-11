import type { OrderDto } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiErrorCode } from '../../../lib/api/errors';
import { getAttempt, resetOrderAttempts } from '../../../lib/order-attempts';
import { qk } from '../../../lib/query-keys';
import type { Channel } from '../pay-outcome';
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
const LABEL = 'Telegram Stars · 50 ⭐';

function setup(channel: Channel = 'web', userId: string | null = USER) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(() => useCreateOrder(userId, channel), { wrapper }),
    invalidate,
  };
}

const keyOf = (call: number): unknown => createOrder.mock.calls[call]?.[1];
const envelope = (code: ApiErrorCode, status: number, details?: unknown, retryAfterSec?: number) =>
  new ApiError({ status, code, details, retryAfterSec, fromServer: true });
const LOST = () => new ApiError({ status: 0, code: 'NETWORK' });

beforeEach(() => {
  createOrder.mockReset();
  resetOrderAttempts();
});

describe('write-ahead', () => {
  it('the attempt is on record BEFORE the request goes out', async () => {
    let seenAtSend: unknown = 'not called';
    createOrder.mockImplementation(() => {
      seenAtSend = getAttempt(USER);
      return Promise.resolve({ order: ORDER });
    });
    const { result } = setup();
    await act(() => result.current.pay('quote_a', LABEL));
    expect(seenAtSend).toMatchObject({ quoteId: 'quote_a', label: LABEL, key: keyOf(0) });
  });

  it('a request that never answers leaves the record behind (the tab can die)', async () => {
    createOrder.mockImplementation(() => new Promise(() => undefined));
    const { result } = setup();
    void result.current.pay('quote_a', LABEL);
    await act(() => Promise.resolve());
    expect(getAttempt(USER)).toMatchObject({ quoteId: 'quote_a' });
  });

  it('a 201 removes the record and spends the key', async () => {
    createOrder.mockResolvedValue({ order: ORDER });
    const { result } = setup();
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'ok',
      orderId: 'order_1',
    });
    expect(getAttempt(USER)).toBeNull();
  });

  it('no user, no purchase: nothing is written or sent', async () => {
    const { result } = setup('web', null);
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'failed',
      code: 'UNAUTHORIZED',
    });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('a first attempt that the server clearly refuses leaves no record', async () => {
    createOrder.mockRejectedValue(envelope('RATE_LIMITED', 429, undefined, 7));
    const { result } = setup();
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'failed',
      code: 'RATE_LIMITED',
      retryAfterSec: 7,
    });
    expect(getAttempt(USER)).toBeNull();
  });
});

describe('Idempotency-Key', () => {
  it('a retry after a lost answer sends the SAME key; a new quote gets a new one', async () => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockResolvedValue({ order: ORDER });
    const { result } = setup();
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'uncertain',
      quoteId: 'quote_a',
    });
    await act(() => result.current.pay('quote_a', LABEL));
    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(typeof keyOf(0)).toBe('string');

    await act(() => result.current.pay('quote_b', LABEL));
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(createOrder.mock.calls[2]?.[0]).toEqual({ quoteId: 'quote_b' });
  });

  it('IDEMPOTENCY_CONFLICT is an ordinary error and the key stays (same body, same key)', async () => {
    createOrder.mockRejectedValueOnce(envelope('IDEMPOTENCY_CONFLICT', 409));
    createOrder.mockResolvedValue({ order: ORDER });
    const { result } = setup();
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'failed',
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await act(() => result.current.pay('quote_a', LABEL));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a quote the server no longer has spends its key: the next quote starts with a new one', async () => {
    createOrder.mockRejectedValueOnce(envelope('QUOTE_EXPIRED', 410));
    createOrder.mockResolvedValue({ order: ORDER });
    const { result } = setup();
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('expired');
    await act(() => result.current.pay('quote_a', LABEL));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});

describe('pressing twice', () => {
  it('is ONE request, and both presses get the same answer', async () => {
    let finish: (value: { order: OrderDto }) => void = () => undefined;
    createOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = setup();
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = result.current.pay('quote_a', LABEL);
      second = result.current.pay('quote_a', LABEL);
      await Promise.resolve();
    });
    expect(createOrder).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ order: ORDER });
      await Promise.all([first, second]);
    });
    expect(await first).toEqual({ kind: 'ok', orderId: 'order_1' });
    expect(await second).toEqual({ kind: 'ok', orderId: 'order_1' });
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});

describe('after a 201', () => {
  it('the wallet and the order lists are fetched again', async () => {
    createOrder.mockResolvedValue({ order: ORDER });
    const { result, invalidate } = setup();
    await act(() => result.current.pay('quote_a', LABEL));
    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(qk.wallet.all);
    expect(keys).toContainEqual(qk.orders.all);
  });

  it('a refusal changes nothing in the caches', async () => {
    createOrder.mockRejectedValue(
      envelope('INSUFFICIENT_BALANCE', 422, { balance: '1', required: '2', shortfall: '1' }),
    );
    const { result, invalidate } = setup();
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('insufficient');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
