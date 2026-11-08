import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { getAttempt, resetOrderAttempts } from '../../../lib/order-attempts';
import type { QuoteView } from '../../product/use-quote';
import {
  ORDER,
  USER_ID,
  controls,
  flow,
  payButton,
  ready,
  renderCheckout,
  serverError,
} from './checkout-kit';

const api = vi.hoisted(() => ({ createOrder: vi.fn(), getWallet: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: api.push, replace: vi.fn() }) }));
vi.mock('../../../lib/api/orders', () => ({ createOrder: api.createOrder }));
vi.mock('../../../lib/api/me', () => ({ getWallet: api.getWallet, getMe: vi.fn() }));
vi.mock('../../../env', async (original) => {
  const actual = await original<typeof import('../../../env')>();
  return { env: { ...actual.env, NEXT_PUBLIC_SUPPORT_URL: 'https://t.me/ggpin_support' } };
});

const LOST = () => new ApiError({ status: 0, code: 'NETWORK' });
const LABEL = 'Telegram Stars · 50 ⭐';
const lapsed = (id: string): QuoteView =>
  ({ ...ready(id, '550000'), expired: true, msLeft: 0 }) as QuoteView;
const checkButton = () => screen.findByRole('button', { name: 'Qayta tekshirish' });
const STORAGE_KEY = `ggpin:order-attempt:v1:${USER_ID}`;
const record = (quoteId: string, key = 'key-written-before-the-reload') => ({
  quoteId,
  key,
  at: Date.now() - 5000,
  label: 'Telegram Premium · 3 oy',
});

beforeEach(() => {
  resetOrderAttempts();
  api.createOrder.mockReset();
  api.push.mockReset();
  api.getWallet.mockReset();
  api.getWallet.mockResolvedValue({ balanceTiyin: '8540000', coins: '0', currency: 'UZS' });
});

async function loseTheAnswer(
  quoteControls = controls(ready('q1', '550000')),
  variant: 'tg' | 'web' = 'web',
) {
  api.createOrder.mockRejectedValueOnce(LOST());
  const user = userEvent.setup();
  const view = renderCheckout(flow(quoteControls, vi.fn(), variant));
  await screen.findByRole('dialog');
  await user.click(payButton());
  await checkButton();
  return { user, quoteControls, ...view };
}

describe('a lost answer', () => {
  it('says the result is unknown and WHICH purchase, offers only "check again" and support, and no price', async () => {
    await loseTheAnswer();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('To‘lov natijasi nomaʼlum');
    expect(dialog).toHaveTextContent(`Xarid: ${LABEL}`);
    expect(dialog).toHaveTextContent(/pul ikki marta yechilmaydi/);
    expect(dialog).toHaveTextContent(/narx hali amal qilsa, tekshiruv shu narxda bir marta/);
    // not the old "payment failed" wording: it may well have gone through
    expect(screen.queryByText('To‘lov amalga oshmadi')).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Yordamga yozish' })).toHaveAttribute(
      'href',
      'https://t.me/ggpin_support',
    );
    expect(screen.queryByRole('button', { name: /^To‘lash · / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Narxni yangilash' })).toBeNull();
    expect(dialog).not.toHaveTextContent('Jami');
    // the amount is not part of the record
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toMatch(/5.?500|550000/);
  });

  it('the local clock running out changes nothing: the check still goes to the SAME quote and key', async () => {
    const { user, rerender } = await loseTheAnswer();
    rerender(flow(controls(lapsed('q1'))));
    expect(await checkButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Narxni yangilash' })).toBeNull();
    api.createOrder.mockResolvedValue({ order: ORDER });
    await user.click(await checkButton());
    await waitFor(() => expect(api.push).toHaveBeenCalledWith('/store/orders/order_1'));
    expect(api.createOrder).toHaveBeenCalledTimes(2);
    expect(api.createOrder.mock.calls[1]?.[0]).toEqual({ quoteId: 'q1' });
    expect(api.createOrder.mock.calls[1]?.[1]).toBe(api.createOrder.mock.calls[0]?.[1]);
  });

  it('a 5xx on the first press is a lost answer too', async () => {
    api.createOrder.mockRejectedValueOnce(serverError({ status: 502, code: 'INTERNAL_ERROR' }));
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    expect(await checkButton()).toBeInTheDocument();
  });
});

describe('the doubt survives the page', () => {
  it('a remount (Back) with another quote on screen still checks the lost one, with its key', async () => {
    const first = await loseTheAnswer();
    first.unmount();
    api.createOrder.mockResolvedValue({ order: ORDER });
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q2', '605000'))));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: /^To‘lash · / })).toBeNull();
    await user.click(await checkButton());
    await waitFor(() => expect(api.push).toHaveBeenCalled());
    expect(api.createOrder.mock.calls[1]?.[0]).toEqual({ quoteId: 'q1' });
    expect(api.createOrder.mock.calls[1]?.[1]).toBe(api.createOrder.mock.calls[0]?.[1]);
  });

  it('a record found after a RELOAD (the tab died mid-request) opens as "result unknown" and checks with its key', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record('q1')));
    api.createOrder.mockResolvedValue({ order: ORDER });
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('To‘lov natijasi nomaʼlum');
    expect(dialog).toHaveTextContent('Xarid: Telegram Premium · 3 oy');
    expect(screen.queryByRole('button', { name: /^To‘lash · / })).toBeNull();
    await user.click(await checkButton());
    await waitFor(() => expect(api.push).toHaveBeenCalled());
    expect(api.createOrder.mock.calls[0]?.[1]).toBe('key-written-before-the-reload');
  });

  it('another tab that starts a purchase turns this tab to "result unknown" at once', async () => {
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('button', { name: /^To‘lash · / });
    act(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record('q5')));
      window.dispatchEvent(
        new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(record('q5')) }),
      );
    });
    expect(await checkButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^To‘lash · / })).toBeNull();
  });

  it('and back again when the other tab settles it', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record('q5')));
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await checkButton();
    act(() => {
      window.localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null }));
    });
    expect(await screen.findByRole('button', { name: /^To‘lash · / })).toBeInTheDocument();
  });

  it('the first press WRITES the record before the request: a request that never answers leaves it', async () => {
    api.createOrder.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    await screen.findByRole('button', { name: 'To‘lanmoqda…' });
    expect(getAttempt(USER_ID)).toMatchObject({ quoteId: 'q1', label: LABEL });
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain('"quoteId":"q1"');
  });
});

describe('which answer to a check ends the doubt', () => {
  it("a proxy's HTML 404 changes nothing and keeps the key", async () => {
    const { user, quoteControls } = await loseTheAnswer();
    api.createOrder.mockRejectedValueOnce(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    await user.click(await checkButton());
    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(2));
    expect(await checkButton()).toBeInTheDocument();
    expect(quoteControls.refresh).not.toHaveBeenCalled();
    expect(getAttempt(USER_ID)?.quoteId).toBe('q1');
    api.createOrder.mockResolvedValue({ order: ORDER });
    await user.click(await checkButton());
    await waitFor(() => expect(api.push).toHaveBeenCalled());
    expect(api.createOrder.mock.calls[2]?.[1]).toBe(api.createOrder.mock.calls[0]?.[1]);
  });

  it('the same 404 on the web may be the CSRF guard: the doubt stays', async () => {
    const { user, quoteControls } = await loseTheAnswer(controls(ready('q1', '550000')), 'web');
    api.createOrder.mockRejectedValueOnce(serverError({ status: 404, code: 'NOT_FOUND' }));
    await user.click(await checkButton());
    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(2));
    expect(await checkButton()).toBeInTheDocument();
    expect(quoteControls.refresh).not.toHaveBeenCalled();
    expect(getAttempt(USER_ID)?.quoteId).toBe('q1');
  });

  it.each([
    ['410', serverError({ status: 410, code: 'QUOTE_EXPIRED' })],
    [
      '422',
      serverError({
        status: 422,
        code: 'INSUFFICIENT_BALANCE',
        details: { balance: '1', required: '2', shortfall: '1' },
      }),
    ],
  ])('an enveloped %s ends the doubt on both channels', async (_s, failure) => {
    const { user } = await loseTheAnswer();
    api.createOrder.mockRejectedValueOnce(failure);
    await user.click(await checkButton());
    await waitFor(() => expect(getAttempt(USER_ID)).toBeNull());
  });

  it('a 410 for an OLD purchase leaves the price on screen alone (no stale mark, no new quote)', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record('q_old')));
    const quoteControls = controls(ready('q2', '605000'));
    api.createOrder.mockRejectedValueOnce(serverError({ status: 410, code: 'QUOTE_EXPIRED' }));
    const user = userEvent.setup();
    renderCheckout(flow(quoteControls));
    await user.click(await checkButton());
    // only the doubt went away: the visitor sees the live price of q2 and may pay it
    expect(await screen.findByRole('button', { name: /^To‘lash · 6.050/ })).toBeInTheDocument();
    expect(quoteControls.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/Narx yangilandi/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Narxni yangilash' })).toBeNull();
  });
});
