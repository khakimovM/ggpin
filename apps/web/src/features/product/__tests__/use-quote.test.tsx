import type { QuoteResponse } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { retryDelaySec } from '../retry-delay';
import { QUOTE_DEBOUNCE_MS, useQuote, type QuoteView, type Selection } from '../use-quote';

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

describe('when a price is asked for', () => {
  it('not without a confirmed recipient, and not without a choice', async () => {
    const a = setup({ token: null, selection: { kind: 'sku', skuId: 's1' } });
    const b = setup({ selection: null });
    await advance(2000);
    expect(createQuote).not.toHaveBeenCalled();
    expect(a.result.current.view.status).toBe('idle');
    expect(b.result.current.view.status).toBe('idle');
  });

  it('a package at once, with exactly the contract body, and shows the server total as is', async () => {
    createQuote.mockResolvedValue(quoteOf('1234567890123456789'));
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    expect(createQuote).toHaveBeenCalledTimes(1);
    expect(createQuote.mock.calls[0]?.[0]).toEqual({
      productId: 'p1',
      skuId: 's1',
      recipientToken: TOKEN,
    });
    const { view } = result.current;
    expect(view.status).toBe('ready');
    // A tiyin string beyond 2^53 stays a string: the browser never turns it into a number.
    if (view.status === 'ready') expect(view.quote.totalTiyin).toBe('1234567890123456789');
  });
});

describe('a quantity is debounced and the overtaken request is cancelled', () => {
  it('the first quantity is asked for at once, then typing three values within 500 ms makes one request, for the last', async () => {
    createQuote.mockResolvedValue(quoteOf('500'));
    const { result, rerender } = setup({ selection: { kind: 'qty', quantity: 50 } });
    await flush();
    expect(createQuote).toHaveBeenCalledTimes(1);
    expect(createQuote.mock.calls[0]?.[0]).toMatchObject({ quantity: 50 });

    rerender({ token: TOKEN, selection: { kind: 'qty', quantity: 51 } });
    await advance(QUOTE_DEBOUNCE_MS - 1);
    rerender({ token: TOKEN, selection: { kind: 'qty', quantity: 52 } });
    await advance(QUOTE_DEBOUNCE_MS - 1);
    rerender({ token: TOKEN, selection: { kind: 'qty', quantity: 53 } });
    await advance(QUOTE_DEBOUNCE_MS - 1);
    expect(createQuote).toHaveBeenCalledTimes(1);
    expect(result.current.view.status).toBe('pending');

    await advance(1);
    expect(createQuote).toHaveBeenCalledTimes(2);
    expect(createQuote.mock.calls[1]?.[0]).toMatchObject({ quantity: 53 });
    await advance(50);
    expect(result.current.view.status).toBe('ready');
  });

  it('a request still on its way is aborted when a newer quantity is asked for', async () => {
    const signals: AbortSignal[] = [];
    createQuote.mockImplementation(
      (_body: unknown, signal: AbortSignal) =>
        new Promise<QuoteResponse>((resolve, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          setTimeout(() => resolve(quoteOf('1')), 60_000);
        }),
    );
    const { result, rerender } = setup({ selection: { kind: 'qty', quantity: 50 } });
    await advance(QUOTE_DEBOUNCE_MS);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    rerender({ token: TOKEN, selection: { kind: 'qty', quantity: 100 } });
    await advance(QUOTE_DEBOUNCE_MS);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    // The answer of the first one is never shown as the price of the second.
    expect(result.current.view.status).toBe('pending');
  });

  it('a quantity that becomes invalid stops asking and shows nothing', async () => {
    createQuote.mockResolvedValue(quoteOf('500'));
    const { result, rerender } = setup({ selection: { kind: 'qty', quantity: 50 } });
    await advance(QUOTE_DEBOUNCE_MS);
    expect(result.current.view.status).toBe('ready');
    rerender({ token: TOKEN, selection: null });
    await advance(QUOTE_DEBOUNCE_MS * 2);
    expect(createQuote).toHaveBeenCalledTimes(1);
    expect(result.current.view.status).toBe('idle');
  });
});

describe('errors', () => {
  it('503 PRICE_UNAVAILABLE: no price, and "retry" asks again', async () => {
    createQuote.mockRejectedValueOnce(new ApiError({ status: 503, code: 'PRICE_UNAVAILABLE' }));
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    expect(result.current.view.status).toBe('unavailable');

    createQuote.mockResolvedValueOnce(quoteOf('700'));
    act(() => result.current.refresh());
    await flush();
    expect(createQuote).toHaveBeenCalledTimes(2);
    expect(result.current.view.status).toBe('ready');
  });

  it('429: repeats by itself after Retry-After, not before', async () => {
    createQuote.mockRejectedValueOnce(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 3 }),
    );
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    expect(result.current.view).toEqual({ status: 'rateLimited', retryInSec: 3 });

    createQuote.mockResolvedValueOnce(quoteOf('700'));
    await advance(2999);
    expect(createQuote).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(createQuote).toHaveBeenCalledTimes(2);
    await advance(50); // the observer is notified on the next tick
    expect(result.current.view.status).toBe('ready');
  });

  it('any other failure is "failed", with a retry', async () => {
    createQuote.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    expect(result.current.view.status).toBe('failed');
  });

  it('Retry-After is clamped to 1..60 s and defaults to 5 s', () => {
    expect(retryDelaySec(undefined)).toBe(5);
    expect(retryDelaySec(0)).toBe(1);
    expect(retryDelaySec(2.2)).toBe(3);
    expect(retryDelaySec(3600)).toBe(60);
  });
});

describe('expiry', () => {
  it('counts down from expiresAt, becomes expired, and does NOT renew by itself', async () => {
    createQuote.mockResolvedValueOnce(quoteOf('700', 10_000));
    const { result } = setup({ selection: { kind: 'sku', skuId: 's1' } });
    await flush();
    let view = result.current.view;
    expect(view.status === 'ready' && view.expired).toBe(false);

    await advance(4000);
    view = result.current.view;
    expect(view.status === 'ready' && view.msLeft).toBeLessThanOrEqual(6000);

    await advance(7000);
    view = result.current.view;
    expect(view.status === 'ready' && view.expired).toBe(true);
    await advance(60_000);
    expect(createQuote).toHaveBeenCalledTimes(1);

    createQuote.mockResolvedValueOnce(quoteOf('710'));
    act(() => result.current.refresh());
    await flush();
    expect(createQuote).toHaveBeenCalledTimes(2);
    view = result.current.view;
    expect(view.status === 'ready' && view.expired).toBe(false);
    if (view.status === 'ready') expect(view.quote.totalTiyin).toBe('710');
  });

  it('a quote that arrives already expired is never shown as live, not even for a frame', async () => {
    createQuote.mockResolvedValueOnce(quoteOf('700', -1000));
    const seen: QuoteView[] = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    // The page sat for a while before the quote was asked for.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    renderHook(
      () => {
        const controls = useQuote('p1', TOKEN, { kind: 'sku', skuId: 's1' });
        seen.push(controls.view);
        return controls;
      },
      { wrapper },
    );
    await flush();
    await advance(50);
    const ready = seen.filter((view) => view.status === 'ready');
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.every((view) => view.status === 'ready' && view.expired)).toBe(true);
  });
});
