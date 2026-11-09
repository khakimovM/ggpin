import type { TopupIntent } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../env';
import { qk } from '../../../lib/query-keys';
import { createFakeWebApp, installWebApp } from '../../../telegram/__tests__/fake-webapp';
import { PENDING_FILTER } from '../use-intent-status';
import { useCancelIntent, useOpenPayPage } from '../use-open-pay-page';

const mocks = vi.hoisted(() => ({ createPayLink: vi.fn(), cancelTopupIntent: vi.fn() }));
vi.mock('../../../lib/api/payments', () => ({
  createPayLink: mocks.createPayLink,
  cancelTopupIntent: mocks.cancelTopupIntent,
}));

const OURS = `${env.NEXT_PUBLIC_SITE_URL}/pay/cm3intent1?locale=uz#t=${'A'.repeat(43)}`;
const FOREIGN = `https://evil.example/pay/cm3intent1#t=${'A'.repeat(43)}`;

beforeEach(() => {
  mocks.createPayLink.mockReset();
  mocks.cancelTopupIntent.mockReset();
});
afterEach(() => {
  delete window.Telegram;
});

describe('useOpenPayPage', () => {
  it('asks for a fresh link and opens it', async () => {
    const app = createFakeWebApp();
    installWebApp(app);
    mocks.createPayLink.mockResolvedValue({ redirectUrl: OURS, expiresAt: 'x' });
    const { result } = renderHook(() => useOpenPayPage());
    let opened: boolean | null = null;
    await act(async () => {
      opened = await result.current.open('cm3intent1');
    });
    expect(opened).toBe(true);
    expect(app.openLink).toHaveBeenCalledTimes(1);
    expect(result.current.held).toBe(false);
  });

  it('two presses are one request', async () => {
    installWebApp(createFakeWebApp());
    let finish: (value: { redirectUrl: string; expiresAt: string }) => void = () => undefined;
    mocks.createPayLink.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useOpenPayPage());
    let first: Promise<boolean | null> = Promise.resolve(null);
    let second: boolean | null = true;
    await act(async () => {
      first = result.current.open('cm3intent1');
      second = await result.current.open('cm3intent1');
    });
    expect(second).toBeNull();
    await act(async () => {
      finish({ redirectUrl: OURS, expiresAt: 'x' });
      await first;
    });
    expect(mocks.createPayLink).toHaveBeenCalledTimes(1);
  });

  it('a client that refuses the call: the link is held for one more press, which opens it', async () => {
    const app = createFakeWebApp();
    installWebApp(app);
    app.openLink = vi.fn(() => {
      throw new Error('refused');
    });
    mocks.createPayLink.mockResolvedValue({ redirectUrl: OURS, expiresAt: 'x' });
    const { result } = renderHook(() => useOpenPayPage());
    await act(async () => {
      expect(await result.current.open('cm3intent1')).toBe(false);
    });
    expect(result.current.held).toBe(true);

    app.openLink = vi.fn();
    act(() => {
      expect(result.current.openHeld()).toBe(true);
    });
    expect(app.openLink).toHaveBeenCalledTimes(1);
    expect(result.current.held).toBe(false);
    expect(result.current.openHeld()).toBe(false); // nothing left to open
  });

  it('a link of another origin is refused and never held', async () => {
    const app = createFakeWebApp();
    installWebApp(app);
    mocks.createPayLink.mockResolvedValue({ redirectUrl: FOREIGN, expiresAt: 'x' });
    const { result } = renderHook(() => useOpenPayPage());
    await act(async () => {
      expect(await result.current.open('cm3intent1')).toBe(false);
    });
    expect(result.current.held).toBe(false);
    expect(app.openLink).not.toHaveBeenCalled();
    expect(result.current.hold(FOREIGN)).toBe(false);
  });
});

describe('useCancelIntent', () => {
  const intent = (over: Partial<TopupIntent> = {}): TopupIntent => ({
    intentId: 'cm3intent1',
    status: 'PENDING',
    baseAmountTiyin: '5000000',
    payAmountTiyin: '5034700',
    card: { bank: 'HUMO', number: '9860123456789012', holderName: 'ALISHER K.' },
    expiresAt: '2026-11-08T12:30:00.000Z',
    currency: 'UZS',
    paidAt: null,
    creditedTiyin: null,
    ...over,
  });
  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, ...renderHook(() => useCancelIntent(), { wrapper }) };
  };

  it('writes CANCELLED and no card into the cache at once, and empties the waiting list', async () => {
    mocks.cancelTopupIntent.mockResolvedValue({ intentId: 'cm3intent1', status: 'CANCELLED' });
    const { client, result } = setup();
    client.setQueryData(qk.payments.intent('cm3intent1'), intent());
    client.setQueryData(qk.payments.intents(PENDING_FILTER), intent());
    await act(async () => {
      expect(await result.current.cancel('cm3intent1')).toBe(true);
    });
    const cached = client.getQueryData<TopupIntent>(qk.payments.intent('cm3intent1'));
    expect(cached?.status).toBe('CANCELLED');
    expect(cached?.card).toBeNull();
    expect(client.getQueryData(qk.payments.intents(PENDING_FILTER))).toBeNull();
  });

  it('a failed cancel changes nothing', async () => {
    mocks.cancelTopupIntent.mockRejectedValue(new Error('x'));
    const { client, result } = setup();
    client.setQueryData(qk.payments.intent('cm3intent1'), intent());
    await act(async () => {
      expect(await result.current.cancel('cm3intent1')).toBe(false);
    });
    expect(client.getQueryData<TopupIntent>(qk.payments.intent('cm3intent1'))?.status).toBe(
      'PENDING',
    );
  });

  it('two presses send one cancel', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.cancelTopupIntent.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = setup();
    let first: Promise<boolean> = Promise.resolve(false);
    let second = true;
    await act(async () => {
      first = result.current.cancel('cm3intent1');
      second = await result.current.cancel('cm3intent1');
    });
    expect(second).toBe(false);
    await act(async () => {
      finish({ intentId: 'cm3intent1', status: 'CANCELLED' });
      await first;
    });
    expect(mocks.cancelTopupIntent).toHaveBeenCalledTimes(1);
  });
});
