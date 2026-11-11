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

describe('an uncertain outcome (the answer was lost)', () => {
  it('is remembered with its quote, and the wallet and orders are read again', async () => {
    createOrder.mockRejectedValue(LOST());
    const { result, invalidate } = setup();
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'uncertain',
      quoteId: 'quote_a',
    });
    expect(getAttempt(USER)?.quoteId).toBe('quote_a');
    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(qk.wallet.all);
    expect(keys).toContainEqual(qk.orders.all);
  });

  it('a 5xx and an unreadable 2xx are uncertain too', async () => {
    createOrder.mockRejectedValueOnce(new ApiError({ status: 502, code: 'INTERNAL_ERROR' }));
    createOrder.mockRejectedValueOnce(new ApiError({ status: 200, code: 'INTERNAL_ERROR' }));
    const { result } = setup();
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('uncertain');
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('uncertain');
  });

  it('the retry sends the SAME key and the SAME quote, then a 201 clears the doubt', async () => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockResolvedValue({ order: ORDER });
    const { result } = setup();
    await act(() => result.current.pay('quote_a', LABEL));
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'ok',
      orderId: 'order_1',
    });
    expect(keyOf(1)).toBe(keyOf(0));
    expect(createOrder.mock.calls[1]?.[0]).toEqual({ quoteId: 'quote_a' });
    expect(getAttempt(USER)).toBeNull();
  });

  it('survives a remount: a new hook instance sends the same key', async () => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockResolvedValue({ order: ORDER });
    const first = setup();
    await act(() => first.result.current.pay('quote_a', LABEL));
    first.unmount();
    const second = setup();
    await act(() => second.result.current.pay('quote_a', LABEL));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('no other quote can be paid while one is in doubt: nothing is sent, the slot is not rewritten', async () => {
    createOrder.mockRejectedValueOnce(LOST());
    const { result } = setup();
    await act(() => result.current.pay('quote_a', LABEL));
    expect(await act(() => result.current.pay('quote_b', 'Telegram Premium · 3 oy'))).toEqual({
      kind: 'uncertain',
      quoteId: 'quote_a',
    });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(getAttempt(USER)).toMatchObject({ quoteId: 'quote_a', label: LABEL });
  });

  it('another account is not held up by it', async () => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockResolvedValue({ order: ORDER });
    const mine = setup();
    await act(() => mine.result.current.pay('quote_a', LABEL));
    const theirs = setup('web', 'user_2');
    expect((await act(() => theirs.result.current.pay('quote_b', LABEL))).kind).toBe('ok');
  });

  it.each<[string, ApiError]>([
    ['410', envelope('QUOTE_EXPIRED', 410)],
    ['422', envelope('INSUFFICIENT_BALANCE', 422, { balance: '1', required: '2', shortfall: '1' })],
  ])('an enveloped %s on the retry says there is no order: the doubt ends', async (_s, failure) => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockRejectedValueOnce(failure);
    createOrder.mockResolvedValue({ order: ORDER });
    const { result } = setup();
    await act(() => result.current.pay('quote_a', LABEL));
    await act(() => result.current.pay('quote_a', LABEL));
    expect(getAttempt(USER)).toBeNull();
    await act(() => result.current.pay('quote_b', LABEL));
    expect(createOrder).toHaveBeenCalledTimes(3);
  });

  it("the API's own 404 on the retry ends the doubt in the Mini App, not on the web", async () => {
    for (const [channel, resolved] of [
      ['tg', true],
      ['web', false],
    ] as const) {
      resetOrderAttempts();
      createOrder.mockReset();
      createOrder.mockRejectedValueOnce(LOST());
      createOrder.mockRejectedValueOnce(envelope('NOT_FOUND', 404));
      const { result } = setup(channel);
      await act(() => result.current.pay('quote_a', LABEL));
      const answer = await act(() => result.current.pay('quote_a', LABEL));
      // the web keeps the doubt: the 404 may be the CSRF guard, so it is NOT reported as "no order"
      expect(answer.kind).toBe(resolved ? 'expired' : 'uncertain');
      expect(getAttempt(USER) === null).toBe(resolved);
    }
  });

  it("a proxy's HTML 404 or 502 on the retry proves nothing: still unresolved, same key", async () => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockRejectedValueOnce(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    createOrder.mockRejectedValueOnce(new ApiError({ status: 502, code: 'INTERNAL_ERROR' }));
    const { result } = setup('tg');
    await act(() => result.current.pay('quote_a', LABEL));
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('uncertain');
    expect((await act(() => result.current.pay('quote_a', LABEL))).kind).toBe('uncertain');
    expect(getAttempt(USER)?.quoteId).toBe('quote_a');
    expect(keyOf(2)).toBe(keyOf(0));
  });

  it('a frozen account or a 429 on the retry is reported as it is, and the record STAYS', async () => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockRejectedValueOnce(envelope('PURCHASE_FROZEN', 403));
    createOrder.mockRejectedValueOnce(envelope('RATE_LIMITED', 429, undefined, 9));
    const { result } = setup();
    await act(() => result.current.pay('quote_a', LABEL));
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({ kind: 'frozen' });
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'failed',
      code: 'RATE_LIMITED',
      retryAfterSec: 9,
    });
    expect(getAttempt(USER)?.quoteId).toBe('quote_a');
    expect(keyOf(2)).toBe(keyOf(0));
  });

  it('QUOTE_ALREADY_USED opens the existing order and ends the doubt', async () => {
    createOrder.mockRejectedValueOnce(LOST());
    createOrder.mockRejectedValueOnce(envelope('QUOTE_ALREADY_USED', 409, { orderId: 'order_9' }));
    const { result, invalidate } = setup();
    await act(() => result.current.pay('quote_a', LABEL));
    invalidate.mockClear();
    expect(await act(() => result.current.pay('quote_a', LABEL))).toEqual({
      kind: 'ok',
      orderId: 'order_9',
    });
    expect(getAttempt(USER)).toBeNull();
    expect(invalidate).toHaveBeenCalled();
  });
});
