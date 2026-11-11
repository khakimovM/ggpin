import type { QuoteResponse } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiErrorCode } from '../../../lib/api/errors';
import { useQuote, type Selection } from '../use-quote';

const createQuote = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api/quotes', () => ({ createQuote }));

const TOKEN = 'T'.repeat(43);
const TEN_MIN = 10 * 60_000;

function quoteOf(total: string, expiresInMs = TEN_MIN): QuoteResponse {
  return {
    quoteId: `q_${total}`,
    priceTiyin: total,
    discountTiyin: '0',
    totalTiyin: total,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    recipient: { username: 'aziz_k', displayName: 'Aziz' },
    currency: 'UZS',
  };
}

function setup(initial: { token?: string | null; selection: Selection | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    (props: { token: string | null; selection: Selection | null }) =>
      useQuote('p1', props.token, props.selection),
    {
      wrapper,
      initialProps: {
        token: initial.token === undefined ? TOKEN : initial.token,
        selection: initial.selection,
      },
    },
  );
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  createQuote.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('answers that say the page is out of date', () => {
  const cases: Array<[string, number, string]> = [
    ['RECIPIENT_INVALID', 422, 'recipientInvalid'],
    ['QTY_OUT_OF_RANGE', 422, 'productChanged'],
    ['PRODUCT_UNAVAILABLE', 422, 'productChanged'],
  ];
  it.each(cases)('%s -> %s', async (code, status, view) => {
    createQuote.mockRejectedValueOnce(
      new ApiError({ status, code: code as ApiErrorCode, details: { min: 50, max: 100 } }),
    );
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    expect(result.current.view.status).toBe(view);
    // No request of its own accord: the page fixes the cause, it does not retry blindly.
    await advance(60_000);
    expect(createQuote).toHaveBeenCalledTimes(1);
  });
});

describe('429 after 429 (a query that already holds a quote)', () => {
  it('every 429 arms its own timer: exactly one request after each, then the price', async () => {
    createQuote.mockResolvedValueOnce(quoteOf('700'));
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    expect(result.current.view.status).toBe('ready');

    // The visitor refreshes; the server says wait 3 s, twice in a row with the SAME Retry-After.
    createQuote.mockRejectedValueOnce(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 3 }),
    );
    act(() => result.current.refresh());
    await advance(50);
    expect(createQuote).toHaveBeenCalledTimes(2);
    expect(result.current.view).toEqual({ status: 'rateLimited', retryInSec: 3 });

    createQuote.mockRejectedValueOnce(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 3 }),
    );
    await advance(3000);
    expect(createQuote).toHaveBeenCalledTimes(3);
    await advance(50);
    // The second 429 shows a live countdown again (it did not freeze on the first one).
    const second = result.current.view;
    expect(second.status).toBe('rateLimited');
    if (second.status === 'rateLimited') expect(second.retryInSec).toBeGreaterThanOrEqual(2);

    createQuote.mockResolvedValueOnce(quoteOf('710'));
    await advance(3100);
    expect(createQuote).toHaveBeenCalledTimes(4);
    await advance(50);
    const done = result.current.view;
    expect(done.status === 'ready' && done.quote.totalTiyin).toBe('710');

    // No storm afterwards.
    await advance(60_000);
    expect(createQuote).toHaveBeenCalledTimes(4);
  });

  it('the countdown runs down second by second', async () => {
    createQuote.mockRejectedValueOnce(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 5 }),
    );
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    await advance(2100);
    const view = result.current.view;
    expect(view.status === 'rateLimited' && view.retryInSec).toBeLessThanOrEqual(3);
  });
});

describe('coming back to a cached answer', () => {
  const A: Selection = { kind: 'sku', skuId: 's1' };
  const B: Selection = { kind: 'sku', skuId: 's2' };

  it('a cached 429 waits only the time that is left, not the whole delay again', async () => {
    createQuote.mockResolvedValueOnce(quoteOf('700'));
    const { result, rerender } = setup({ selection: A });
    await flush();
    createQuote.mockRejectedValueOnce(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 10 }),
    );
    act(() => result.current.refresh());
    await advance(50);
    expect(createQuote).toHaveBeenCalledTimes(2);

    // Away to another package for 4 s, then back.
    createQuote.mockResolvedValueOnce(quoteOf('800'));
    rerender({ token: TOKEN, selection: B });
    await advance(4000);
    expect(createQuote).toHaveBeenCalledTimes(3);
    rerender({ token: TOKEN, selection: A });
    await advance(50);
    const view = result.current.view;
    expect(createQuote).toHaveBeenCalledTimes(3); // coming back asks nothing at once
    expect(view.status === 'rateLimited' && view.retryInSec).toBeLessThanOrEqual(6);

    // About 4 s of the 10 are gone: the request goes after the rest (~6 s), not after 10 more.
    createQuote.mockResolvedValueOnce(quoteOf('710'));
    await advance(5000);
    expect(createQuote).toHaveBeenCalledTimes(3);
    await advance(1500);
    expect(createQuote).toHaveBeenCalledTimes(4);
  });

  it('coming back to a quote that expired meanwhile shows it expired, asks nothing, and refresh asks', async () => {
    createQuote.mockResolvedValueOnce(quoteOf('700'));
    const { result, rerender } = setup({ selection: A });
    await flush();
    const first = result.current.view;
    expect(first.status === 'ready' && first.expired).toBe(false);
    await advance(TEN_MIN / 2);

    // Away to B while A's quote runs out (its lifetime is ten minutes from the send).
    createQuote.mockResolvedValueOnce(quoteOf('800'));
    rerender({ token: TOKEN, selection: B });
    await advance(TEN_MIN / 2 + 1000);
    expect(createQuote).toHaveBeenCalledTimes(2);

    rerender({ token: TOKEN, selection: A });
    await advance(50);
    const back = result.current.view;
    // Its own price, and expired: the button stays off, "Narxni yangilash" is offered.
    expect(back.status).toBe('ready');
    expect(back.status === 'ready' && back.quote.totalTiyin).toBe('700');
    expect(back.status === 'ready' && back.expired).toBe(true);
    // Coming back asks the server nothing, however long it has been.
    await advance(5000);
    expect(createQuote).toHaveBeenCalledTimes(2);

    // Only the visitor's refresh asks, and it brings a live price.
    createQuote.mockResolvedValueOnce(quoteOf('710'));
    act(() => result.current.refresh());
    await advance(50);
    expect(createQuote).toHaveBeenCalledTimes(3);
    const renewed = result.current.view;
    expect(renewed.status === 'ready' && renewed.quote.totalTiyin).toBe('710');
    expect(renewed.status === 'ready' && renewed.expired).toBe(false);
  });

  it('after discard() the same request is asked again, not answered with the old error', async () => {
    createQuote.mockResolvedValueOnce(quoteOf('700'));
    const { result, rerender } = setup({ selection: A });
    await flush();
    createQuote.mockRejectedValueOnce(new ApiError({ status: 422, code: 'RECIPIENT_INVALID' }));
    act(() => result.current.refresh());
    await advance(50);
    expect(result.current.view.status).toBe('recipientInvalid');
    expect(createQuote).toHaveBeenCalledTimes(2);

    // The page forgets the answer and the token; a new lookup returns the very same token.
    act(() => result.current.discard());
    rerender({ token: null, selection: A });
    await advance(50);
    createQuote.mockResolvedValueOnce(quoteOf('720'));
    rerender({ token: TOKEN, selection: A });
    await advance(50);
    expect(createQuote).toHaveBeenCalledTimes(3);
    const view = result.current.view;
    expect(view.status === 'ready' && view.quote.totalTiyin).toBe('720');
  });
});
