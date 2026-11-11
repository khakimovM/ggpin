import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrderAttempts } from '../../../lib/order-attempts';
import { ORDER, USER_ID, controls, flow, payButton, ready, renderCheckout } from './checkout-kit';

const api = vi.hoisted(() => ({ createOrder: vi.fn(), getWallet: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: api.push, replace: vi.fn() }) }));
vi.mock('../../../lib/api/orders', () => ({ createOrder: api.createOrder }));
vi.mock('../../../lib/api/me', () => ({ getWallet: api.getWallet, getMe: vi.fn() }));

const KEY = `ggpin:order-attempt:v1:${USER_ID}`;

beforeEach(() => {
  resetOrderAttempts();
  api.createOrder.mockReset();
  api.push.mockReset();
  api.getWallet.mockReset();
  api.getWallet.mockResolvedValue({ balanceTiyin: '8540000', coins: '0', currency: 'UZS' });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
});

type Grant = { name: string } | null;
const takeLock = (granted: boolean) =>
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, _options: unknown, callback: (lock: Grant) => unknown) =>
        Promise.resolve(callback(granted ? { name } : null)),
    },
  });

describe('a payment on its way in another window', () => {
  it('nothing is sent; the sheet says so and offers a retry', async () => {
    takeLock(false);
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    expect(await screen.findByText(/Boshqa oynada to‘lov ketmoqda/)).toBeInTheDocument();
    expect(api.createOrder).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByRole('button', { name: /^To‘lash · / })).toBeInTheDocument();
  });

  it('when the other window has already written its record, the sheet turns to "result unknown" with the message inside', async () => {
    takeLock(false);
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        quoteId: 'q_other',
        key: 'key-of-the-other-window',
        at: Date.now(),
        label: 'Telegram Premium · 3 oy',
      }),
    );
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    // the record is found at once: the doubt is shown before anything is pressed
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('To‘lov natijasi nomaʼlum');
    expect(dialog).toHaveTextContent('Xarid: Telegram Premium · 3 oy');
    await user.click(await screen.findByRole('button', { name: 'Qayta tekshirish' }));
    expect(await screen.findByText(/Boshqa oynada to‘lov ketmoqda/)).toBeInTheDocument();
    expect(api.createOrder).not.toHaveBeenCalled();
  });
});

describe('the message goes with the record of the other window', () => {
  it('when that window settles and removes its record, "a payment is on its way" disappears', async () => {
    takeLock(false);
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        quoteId: 'q_other',
        key: 'key-of-the-other-window',
        at: Date.now(),
        label: 'Telegram Premium · 3 oy',
      }),
    );
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await user.click(await screen.findByRole('button', { name: 'Qayta tekshirish' }));
    expect(await screen.findByText(/Boshqa oynada to‘lov ketmoqda/)).toBeInTheDocument();
    act(() => {
      window.localStorage.removeItem(KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
    });
    await waitFor(() => expect(screen.queryByText(/Boshqa oynada to‘lov ketmoqda/)).toBeNull());
    expect(await screen.findByRole('button', { name: /^To‘lash · / })).toBeInTheDocument();
  });

  it('with no record at the time, the message stays until the visitor retries', async () => {
    takeLock(false);
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    expect(await screen.findByText(/Boshqa oynada to‘lov ketmoqda/)).toBeInTheDocument();
    expect(screen.getByText(/Boshqa oynada to‘lov ketmoqda/)).toBeInTheDocument();
  });
});

describe('the payment machinery itself fails', () => {
  // A lock manager that runs the chain and then rejects: pay() rejects although nothing was answered.
  const crashingLocks = () =>
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: (lock: Grant) => unknown) => {
          callback(null);
          return Promise.reject(new Error('lock manager crashed'));
        },
      },
    });

  it('the spinner goes, the closing prompt goes, and the button works again', async () => {
    crashingLocks();
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    expect(await screen.findByRole('button', { name: /^To‘lash · / })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'To‘lanmoqda…' })).toBeNull();
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });

  it('with a record on file the sheet is "result unknown", not stuck', async () => {
    crashingLocks();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        quoteId: 'q1',
        key: 'key-written-before',
        at: Date.now(),
        label: 'Telegram Stars · 50 ⭐',
      }),
    );
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await user.click(await screen.findByRole('button', { name: 'Qayta tekshirish' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Tekshirilmoqda…' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Qayta tekshirish' })).toBeEnabled();
    expect(screen.getByRole('dialog')).toHaveTextContent('To‘lov natijasi nomaʼlum');
  });
});

describe('a refetch that hangs after the payment', () => {
  it('the order page opens, the button is not stuck, the closing prompt is off', async () => {
    api.getWallet.mockReset();
    api.getWallet.mockResolvedValueOnce({ balanceTiyin: '8540000', coins: '0', currency: 'UZS' });
    api.getWallet.mockReturnValue(new Promise(() => undefined)); // the refetch after the order hangs
    api.createOrder.mockResolvedValue({ order: ORDER });
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    await waitFor(() => expect(api.push).toHaveBeenCalledWith('/store/orders/order_1'));
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });
});
