import type { OrderDto } from '@repo/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrderAttempts } from '../../../lib/order-attempts';
import { runBackHandler } from '../../../telegram/back-stack';
import { createFakeWebApp } from '../../../telegram/__tests__/fake-webapp';
import { TelegramContext } from '../../../telegram/telegram-context';
import {
  ORDER,
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

beforeEach(() => {
  resetOrderAttempts();
  api.createOrder.mockReset();
  api.push.mockReset();
  api.getWallet.mockReset();
  api.getWallet.mockResolvedValue({ balanceTiyin: '8540000', coins: '0', currency: 'UZS' });
});

const pending = () => {
  let finish: (value: { order: OrderDto }) => void = () => undefined;
  api.createOrder.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  return {
    finish: () =>
      act(() => {
        finish({ order: ORDER });
        return Promise.resolve();
      }),
  };
};

describe('the quote already became an order', () => {
  it('409 QUOTE_ALREADY_USED opens that order, as a 201 would', async () => {
    api.createOrder.mockRejectedValue(
      serverError({ status: 409, code: 'QUOTE_ALREADY_USED', details: { orderId: 'order_9' } }),
    );
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    await waitFor(() => expect(api.push).toHaveBeenCalledWith('/store/orders/order_9'));
  });
});

describe('no price loop', () => {
  it('a second "no such quote" in a row is an error, not another new quote', async () => {
    api.createOrder.mockRejectedValue(serverError({ status: 404, code: 'NOT_FOUND' }));
    const quoteControls = controls(ready('q1', '550000'));
    const user = userEvent.setup();
    const { rerender } = renderCheckout(flow(quoteControls));
    await screen.findByRole('dialog');
    await user.click(payButton());
    await waitFor(() => expect(quoteControls.refresh).toHaveBeenCalledTimes(1));
    const fresh = controls(ready('q2', '605000'));
    rerender(flow(fresh));
    await user.click(await screen.findByRole('button', { name: 'Yangi narx bilan davom etish' }));
    await user.click(await screen.findByRole('button', { name: /^To‘lash · 6.050/ }));
    expect(await screen.findByText(/Ichki xatolik yuz berdi/)).toBeInTheDocument();
    expect(fresh.refresh).not.toHaveBeenCalled();
    expect(api.createOrder).toHaveBeenCalledTimes(2);
  });
});

describe('presses', () => {
  it('two taps in the same tick open the order page ONCE', async () => {
    const answer = pending();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    const button = await screen.findByRole('button', { name: /^To‘lash · / });
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    await answer.finish();
    await waitFor(() => expect(api.push).toHaveBeenCalled());
    expect(api.createOrder).toHaveBeenCalledTimes(1);
    expect(api.push).toHaveBeenCalledTimes(1);
  });
});

describe('leaving the page while the request is on its way', () => {
  it('on the web the browser asks before the tab is closed, and only while the request runs', async () => {
    const answer = pending();
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await user.click(payButton());
    await screen.findByRole('button', { name: 'To‘lanmoqda…' });
    expect(leave()).toBe(true);
    await answer.finish();
    await waitFor(() => expect(api.push).toHaveBeenCalled());
    expect(leave()).toBe(false);
  });
});

describe('in the Mini App', () => {
  const tg = (app: ReturnType<typeof createFakeWebApp>, onOpenChange = vi.fn()) => (
    <TelegramContext.Provider value={{ phase: 'telegram', webApp: app }}>
      {flow(controls(ready('q1', '550000')), onOpenChange, 'tg')}
    </TelegramContext.Provider>
  );

  it('Telegram\'s MainButton becomes "Qayta tekshirish" and checks with the same key', async () => {
    api.createOrder.mockRejectedValueOnce(new Error('offline'));
    api.createOrder.mockResolvedValue({ order: ORDER });
    const app = createFakeWebApp();
    window.Telegram = { WebApp: app };
    renderCheckout(tg(app));
    await screen.findByRole('dialog');
    act(() => app.pressMain());
    await waitFor(() =>
      expect(app.MainButton.setText).toHaveBeenLastCalledWith('Qayta tekshirish'),
    );
    act(() => app.pressMain());
    await waitFor(() => expect(api.push).toHaveBeenCalledWith('/tg/orders/order_1'));
    expect(api.createOrder.mock.calls[1]?.[1]).toBe(api.createOrder.mock.calls[0]?.[1]);
    delete window.Telegram;
  });

  it('Telegram is asked to confirm closing while the request runs, and released after', async () => {
    const answer = pending();
    const app = createFakeWebApp();
    window.Telegram = { WebApp: app };
    renderCheckout(tg(app));
    await screen.findByRole('dialog');
    expect(app.enableClosingConfirmation).not.toHaveBeenCalled();
    act(() => app.pressMain());
    await waitFor(() => expect(app.enableClosingConfirmation).toHaveBeenCalledTimes(1));
    expect(app.disableClosingConfirmation).not.toHaveBeenCalled();
    await answer.finish();
    await waitFor(() => expect(app.disableClosingConfirmation).toHaveBeenCalledTimes(1));
    delete window.Telegram;
  });

  it('an old client without the method does not break the payment', async () => {
    const answer = pending();
    const app = createFakeWebApp();
    const old = { ...app, enableClosingConfirmation: undefined };
    window.Telegram = { WebApp: old };
    renderCheckout(tg(old));
    await screen.findByRole('dialog');
    act(() => app.pressMain());
    await waitFor(() => expect(api.createOrder).toHaveBeenCalled());
    await answer.finish();
    await waitFor(() => expect(api.push).toHaveBeenCalled());
    delete window.Telegram;
  });

  it('the BackButton does nothing while the payment is on its way', async () => {
    const answer = pending();
    const onOpenChange = vi.fn();
    const app = createFakeWebApp();
    window.Telegram = { WebApp: app };
    renderCheckout(tg(app, onOpenChange));
    await screen.findByRole('dialog');
    act(() => app.pressMain());
    await waitFor(() => expect(app.MainButton.showProgress).toHaveBeenCalled());
    act(() => {
      runBackHandler();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    await answer.finish();
    await waitFor(() => expect(api.push).toHaveBeenCalled());
    delete window.Telegram;
  });

  it('the BackButton still closes the sheet when nothing is on its way', async () => {
    const onOpenChange = vi.fn();
    const app = createFakeWebApp();
    window.Telegram = { WebApp: app };
    renderCheckout(tg(app, onOpenChange));
    await screen.findByRole('dialog');
    act(() => {
      runBackHandler();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    delete window.Telegram;
  });
});
