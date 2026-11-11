import type { PayView } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { usePayView } from '../use-pay-view';

const mocks = vi.hoisted(() => ({ getPayView: vi.fn() }));
vi.mock('../../../lib/api/payments', () => ({ getPayView: mocks.getPayView }));

// Built, not spelled out: a 43-character base64url literal looks like a secret to scanners.
const OLD = `${'Tk'.repeat(21)}x`;
const NEW = `${'Zq'.repeat(21)}y`;
const VIEW: PayView = {
  intentId: 'cm3intent1',
  status: 'PENDING',
  baseAmountTiyin: '5000000',
  payAmountTiyin: '5034700',
  card: { bank: 'HUMO', number: '9860123456789012', holderName: 'ALISHER K.' },
  expiresAt: '2026-11-08T12:30:00.000Z',
  ownerHint: 'S***r',
  currency: 'UZS',
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ token }) => usePayView('cm3intent1', token), {
    wrapper,
    initialProps: { token: OLD },
  });
}

// Braces: vitest runs a function returned by beforeEach as a teardown, and mockReset returns the mock.
beforeEach(() => {
  mocks.getPayView.mockReset();
});

describe('usePayView and a replaced link', () => {
  it('the late "unknown token" for the OLD token does not touch the answer for the NEW one', async () => {
    let refuseOld: (error: unknown) => void = () => undefined;
    mocks.getPayView.mockImplementation((_id: string, token: string) =>
      token === OLD
        ? new Promise((_resolve, reject) => (refuseOld = reject)) // ignores the abort signal
        : Promise.resolve(VIEW),
    );
    const { result, rerender } = setup();
    await waitFor(() => expect(mocks.getPayView).toHaveBeenCalledTimes(1));

    rerender({ token: NEW });
    await waitFor(() => expect(result.current.query.data).toEqual(VIEW));
    await waitFor(() => expect(result.current.answeredToken).toBe(NEW));

    await act(async () => {
      refuseOld(new ApiError({ status: 404, code: 'NOT_FOUND', fromServer: true }));
      await Promise.resolve();
    });
    expect(result.current.query.error).toBeNull();
    expect(result.current.query.data).toEqual(VIEW);
    expect(result.current.answeredToken).toBe(NEW);
    expect(mocks.getPayView.mock.calls.map((call: unknown[]) => call[1])).toEqual([OLD, NEW]);
  });

  it('an answer says which token it was given for', async () => {
    mocks.getPayView.mockResolvedValue(VIEW);
    const { result } = setup();
    await waitFor(() => expect(result.current.query.data).toEqual(VIEW));
    expect(result.current.answeredToken).toBe(OLD);
  });

  it('an "unknown token" for the CURRENT token says it was given for that token (the page may erase it)', async () => {
    mocks.getPayView.mockImplementation(() =>
      Promise.reject(new ApiError({ status: 404, code: 'NOT_FOUND', fromServer: true })),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.query.error).toBeInstanceOf(ApiError));
    expect(result.current.answeredToken).toBe(OLD);
    expect(mocks.getPayView).toHaveBeenCalledTimes(1); // a 404 stops the poll
  });
});
