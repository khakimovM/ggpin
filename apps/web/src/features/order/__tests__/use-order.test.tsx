import type { OrderDetail, OrderStatus } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import uz from '@repo/i18n/uz.json';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { ORDER_POLL_MS, ORDER_REVIEW_POLL_MS } from '../order-status';
import { useOrder } from '../use-order';

const getOrder = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api/orders', () => ({ getOrder }));

function detail(status: OrderStatus): OrderDetail {
  return {
    id: 'o1',
    number: 7,
    status,
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
    timeline: [{ status: 'PAID', at: '2026-11-08T10:00:00.000Z' }],
    voucher: null,
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NextIntlClientProvider locale="uz" messages={uz}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </NextIntlClientProvider>
  );
  return renderHook(() => useOrder('o1'), { wrapper });
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  getOrder.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('polling', () => {
  it('asks every two seconds while the order moves, and stops for good at DELIVERED', async () => {
    getOrder.mockResolvedValueOnce(detail('PAID'));
    getOrder.mockResolvedValueOnce(detail('PROCESSING'));
    getOrder.mockResolvedValue(detail('DELIVERED'));
    const { result } = setup();
    await advance(0);
    expect(result.current.data?.status).toBe('PAID');
    expect(getOrder).toHaveBeenCalledTimes(1);

    await advance(ORDER_POLL_MS - 1);
    expect(getOrder).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getOrder).toHaveBeenCalledTimes(2);
    await advance(50); // the observer is told on the next tick
    expect(result.current.data?.status).toBe('PROCESSING');

    await advance(ORDER_POLL_MS);
    expect(getOrder).toHaveBeenCalledTimes(3);
    await advance(50);
    expect(result.current.data?.status).toBe('DELIVERED');

    // settled: nothing more, however long it stays open
    await advance(60_000);
    expect(getOrder).toHaveBeenCalledTimes(3);
  });

  it.each<OrderStatus>(['FAILED', 'REFUNDED', 'CANCELLED'])('%s is settled too', async (status) => {
    getOrder.mockResolvedValue(detail(status));
    setup();
    await advance(0);
    await advance(30_000);
    expect(getOrder).toHaveBeenCalledTimes(1);
  });

  it.each<OrderStatus>(['HELD', 'NEEDS_REVIEW'])(
    '%s keeps being asked about, but slowly (it waits for a person)',
    async (status) => {
      getOrder.mockResolvedValue(detail(status));
      setup();
      await advance(0);
      expect(getOrder).toHaveBeenCalledTimes(1);
      // not at the fast interval...
      await advance(ORDER_POLL_MS * 5);
      expect(getOrder).toHaveBeenCalledTimes(1);
      // ...but at the slow one, again and again
      await advance(ORDER_REVIEW_POLL_MS - ORDER_POLL_MS * 5);
      expect(getOrder).toHaveBeenCalledTimes(2);
      await advance(ORDER_REVIEW_POLL_MS);
      expect(getOrder).toHaveBeenCalledTimes(3);
    },
  );

  it('a failed poll between two good ones does not stop the polling', async () => {
    getOrder.mockResolvedValueOnce(detail('PROCESSING'));
    getOrder.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    getOrder.mockResolvedValue(detail('DELIVERED'));
    const { result } = setup();
    await advance(0);
    await advance(ORDER_POLL_MS);
    await advance(ORDER_POLL_MS);
    await advance(50);
    expect(result.current.data?.status).toBe('DELIVERED');
  });

  it('an order that cannot be loaded at all is not asked about again by itself', async () => {
    getOrder.mockRejectedValue(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    const { result } = setup();
    await advance(0);
    await advance(30_000);
    expect(result.current.isError).toBe(true);
    expect(getOrder).toHaveBeenCalledTimes(1);
  });

  it('asks in the language of the page', async () => {
    getOrder.mockResolvedValue(detail('DELIVERED'));
    setup();
    await advance(0);
    expect(getOrder).toHaveBeenCalledWith('o1', 'uz', expect.anything());
  });
});
