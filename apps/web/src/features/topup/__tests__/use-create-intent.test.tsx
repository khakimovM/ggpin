import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { useCreateIntent } from '../use-create-intent';

const mocks = vi.hoisted(() => ({ createTopupIntent: vi.fn() }));
vi.mock('../../../lib/api/payments', () => ({ createTopupIntent: mocks.createTopupIntent }));

const CREATED = { intentId: 'cm3intent1', redirectUrl: 'https://ggpin.example/pay/cm3intent1#t=x' };
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const keyOf = (call: number) => mocks.createTopupIntent.mock.calls[call]?.[1] as string;

beforeEach(() => {
  mocks.createTopupIntent.mockReset();
});

describe('useCreateIntent', () => {
  it('sends the amount in tiyin as a string, with the purpose TOPUP and a key', async () => {
    mocks.createTopupIntent.mockResolvedValue(CREATED);
    const { result } = renderHook(() => useCreateIntent(), { wrapper });
    let outcome;
    await act(async () => {
      outcome = await result.current.create('50000', 'HUMO');
    });
    expect(outcome).toEqual({ kind: 'created', ...CREATED });
    expect(mocks.createTopupIntent).toHaveBeenCalledWith(
      { provider: 'P2P_CARD', amountTiyin: '5000000', purpose: 'TOPUP', bank: 'HUMO' },
      expect.stringMatching(/^[\w-]{16,}$/),
    );
  });

  it('a lost answer is NOT retried by itself; pressing again carries the same key', async () => {
    mocks.createTopupIntent.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mocks.createTopupIntent.mockResolvedValueOnce(CREATED);
    const { result } = renderHook(() => useCreateIntent(), { wrapper });
    await act(async () => {
      expect(await result.current.create('50000', undefined)).toEqual({
        kind: 'failed',
        code: 'NETWORK',
      });
    });
    expect(mocks.createTopupIntent).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.create('50000', undefined);
    });
    expect(mocks.createTopupIntent).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('another amount or bank is another body and gets a new key', async () => {
    mocks.createTopupIntent.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useCreateIntent(), { wrapper });
    for (const [amount, bank] of [
      ['50000', undefined],
      ['60000', undefined],
      ['60000', 'UZCARD'],
    ] as const) {
      await act(async () => {
        await result.current.create(amount, bank);
      });
    }
    expect(new Set([keyOf(0), keyOf(1), keyOf(2)]).size).toBe(3);
  });

  it('a definite answer ends the key: the next attempt of the same body starts fresh', async () => {
    mocks.createTopupIntent.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'TOPUP_ALREADY_PENDING',
        details: { intentId: 'cm3intent1' },
        fromServer: true,
      }),
    );
    const { result } = renderHook(() => useCreateIntent(), { wrapper });
    await act(async () => {
      expect(await result.current.create('50000', undefined)).toEqual({
        kind: 'pending',
        intentId: 'cm3intent1',
      });
    });
    await act(async () => {
      await result.current.create('50000', undefined);
    });
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('a double press is one request', async () => {
    let finish: (value: typeof CREATED) => void = () => undefined;
    mocks.createTopupIntent.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useCreateIntent(), { wrapper });
    let first: Promise<unknown> = Promise.resolve();
    let second: unknown = 'unset';
    await act(async () => {
      first = result.current.create('50000', undefined);
      second = await result.current.create('50000', undefined);
    });
    expect(second).toBeNull();
    await act(async () => {
      finish(CREATED);
      await first;
    });
    expect(mocks.createTopupIntent).toHaveBeenCalledTimes(1);
  });

  it('a 429 with Retry-After keeps the button off for that long and says how long', async () => {
    mocks.createTopupIntent.mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30, fromServer: true }),
    );
    const { result } = renderHook(() => useCreateIntent(), { wrapper });
    expect(result.current.waitMs).toBe(0);
    await act(async () => {
      expect(await result.current.create('50000', undefined)).toEqual({
        kind: 'rate',
        retryAfterSec: 30,
      });
    });
    await waitFor(() => expect(result.current.waitMs).toBeGreaterThan(28_000));
    expect(result.current.waitMs).toBeLessThanOrEqual(30_000);
  });

  it('keeps the pay link out of every cache', async () => {
    mocks.createTopupIntent.mockResolvedValue(CREATED);
    const { result } = renderHook(() => useCreateIntent(), { wrapper });
    await act(async () => {
      await result.current.create('50000', undefined);
    });
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('#t=');
  });
});
