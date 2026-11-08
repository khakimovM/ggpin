import type { OrderDto } from '@repo/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrderAttempts } from '../../../lib/order-attempts';
import { TelegramContext } from '../../../telegram/telegram-context';
import { createFakeWebApp } from '../../../telegram/__tests__/fake-webapp';
import type { QuoteControls, QuoteView } from '../../product/use-quote';
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

describe('the confirmation', () => {
  it('shows what is bought, for whom, the server price and the wallet before and after', async () => {
    renderCheckout(flow(controls(ready('q1', '550000'))));
    const dialog = await screen.findByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
    expect(within(dialog).getByText('Telegram Stars · 50 ⭐')).toBeInTheDocument();
    expect(within(dialog).getByText('@dilnoza_k · Dilnoza K.')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/Narx\s*5.500\s*so‘m/);
    expect(dialog).toHaveTextContent(/Jami\s*5.500\s*so‘m/);
    // 85 400 -> 79 900: the one display-only subtraction, from the server's strings.
    await waitFor(() => expect(dialog).toHaveTextContent(/85.400\s*so‘m\s*→\s*79.900\s*so‘m/));
    expect(dialog).toHaveTextContent(/Narx 9:00 daqiqa amal qiladi/);
    expect(payButton()).toHaveTextContent(/5.500\s*so‘m/);
  });

  it('shows no "left" figure when the wallet is not known', async () => {
    api.getWallet.mockRejectedValue(serverError({ status: 500, code: 'INTERNAL_ERROR' }));
    renderCheckout(flow(controls(ready('q1', '550000'))));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent('→');
  });
});

describe('paying', () => {
  it('201: ONE request with the quote and a key, the order page opens, the sheet closes', async () => {
    api.createOrder.mockResolvedValue({ order: ORDER });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    const quoteControls = controls(ready('q1', '550000'));
    renderCheckout(flow(quoteControls, onOpenChange));
    await screen.findByRole('dialog');
    await user.dblClick(payButton());
    await waitFor(() => expect(api.push).toHaveBeenCalledWith('/store/orders/order_1'));
    expect(api.createOrder).toHaveBeenCalledTimes(1);
    expect(api.push).toHaveBeenCalledTimes(1);
    expect(api.createOrder.mock.calls[0]?.[0]).toEqual({ quoteId: 'q1' });
    expect(typeof api.createOrder.mock.calls[0]?.[1]).toBe('string');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The quote became an order: it is dropped, so Back does not show its price as live.
    expect(quoteControls.discard).toHaveBeenCalledTimes(1);
  });

  it('while the request runs the button shows progress, and presses do nothing', async () => {
    let finish: (value: { order: OrderDto }) => void = () => undefined;
    api.createOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    const busy = await screen.findByRole('button', { name: 'To‘lanmoqda…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await user.click(busy);
    expect(api.createOrder).toHaveBeenCalledTimes(1);
    await act(() => {
      finish({ order: ORDER });
      return Promise.resolve();
    });
    await waitFor(() => expect(api.push).toHaveBeenCalled());
  });
});

describe('every answer has its screen', () => {
  it('422 INSUFFICIENT_BALANCE: the server numbers, top-up not available yet, a way to close', async () => {
    api.createOrder.mockRejectedValue(
      serverError({
        status: 422,
        code: 'INSUFFICIENT_BALANCE',
        details: { balance: '8540000', required: '12245000', shortfall: '3705000' },
      }),
    );
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '12245000')), onOpenChange));
    await screen.findByRole('dialog');
    await user.click(payButton());
    const sheet = await screen.findByRole('dialog', { name: 'Mablag‘ yetarli emas' });
    expect(sheet).toHaveTextContent(/Balansingiz:\s*85.400\s*so‘m/);
    expect(sheet).toHaveTextContent(/Narx:\s*122.450\s*so‘m/);
    expect(sheet).toHaveTextContent(/Yetishmaydi:\s*37.050\s*so‘m/);
    // Until the wallet slice exists: top-up is off and marked, "pay and buy" is not offered.
    expect(within(sheet).getByRole('button', { name: /Hisobni to‘ldirish/ })).toBeDisabled();
    expect(within(sheet).getByText('Tez orada')).toBeInTheDocument();
    expect(within(sheet).queryByText(/to‘ldirish va sotib olish/)).toBeNull();
    // (the sheet's own close button carries the same name: the text button is the last one)
    const closers = within(sheet).getAllByRole('button', { name: 'Yopish' });
    const textButton = closers[closers.length - 1];
    if (textButton === undefined) throw new Error('no close button');
    await user.click(textButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(api.push).not.toHaveBeenCalled();
  });

  it('410 QUOTE_EXPIRED: a new price is fetched, shown, and the next payment uses the NEW quote and key', async () => {
    api.createOrder.mockRejectedValueOnce(serverError({ status: 410, code: 'QUOTE_EXPIRED' }));
    api.createOrder.mockResolvedValue({ order: ORDER });
    const quoteControls = controls(ready('q1', '550000'));
    const user = userEvent.setup();
    const { rerender } = renderCheckout(flow(quoteControls));
    await screen.findByRole('dialog');
    await user.click(payButton());
    await waitFor(() => expect(quoteControls.refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Narxni yangilash' })).toBeInTheDocument();

    // The renewed quote arrives with another price.
    const fresh = controls(ready('q2', '605000'));
    rerender(flow(fresh));
    expect(await screen.findByText(/Narx yangilandi: 6.050\s*so‘m/)).toBeInTheDocument();
    expect(screen.getByText(/Yangi narx 10 daqiqa amal qiladi/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yangi narx bilan davom etish' }));
    await user.click(await screen.findByRole('button', { name: /^To‘lash · 6.050/ }));
    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(2));
    expect(api.createOrder.mock.calls[1]?.[0]).toEqual({ quoteId: 'q2' });
    expect(api.createOrder.mock.calls[1]?.[1]).not.toBe(api.createOrder.mock.calls[0]?.[1]);
  });

  it('a price that ran out on the clock: "Narxni yangilash", and no payment is possible', async () => {
    const lapsed: QuoteView = { ...ready('q1', '550000'), expired: true, msLeft: 0 } as QuoteView;
    const quoteControls = controls(lapsed);
    const user = userEvent.setup();
    renderCheckout(flow(quoteControls));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: /^To‘lash · / })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Narxni yangilash' }));
    expect(quoteControls.refresh).toHaveBeenCalledTimes(1);
    expect(api.createOrder).not.toHaveBeenCalled();
  });

  it('409 IDEMPOTENCY_CONFLICT is an ordinary error: its message, no new quote, the sheet stays', async () => {
    api.createOrder.mockRejectedValueOnce(
      serverError({ status: 409, code: 'IDEMPOTENCY_CONFLICT' }),
    );
    const quoteControls = controls(ready('q1', '550000'));
    const user = userEvent.setup();
    renderCheckout(flow(quoteControls));
    await screen.findByRole('dialog');
    await user.click(payButton());
    expect(
      await screen.findByText(/boshqa maʼlumot bilan allaqachon ishlatilgan/),
    ).toBeInTheDocument();
    expect(quoteControls.refresh).not.toHaveBeenCalled();
  });

  it('403 PURCHASE_FROZEN: a message that says why, and nothing to retry', async () => {
    api.createOrder.mockRejectedValue(serverError({ status: 403, code: 'PURCHASE_FROZEN' }));
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    const sheet = await screen.findByRole('dialog', { name: 'Xaridlar vaqtincha cheklangan' });
    expect(sheet).toHaveTextContent(/to‘lovingiz qaytarilgani/i);
    expect(within(sheet).queryByRole('button', { name: /^To‘lash/ })).toBeNull();
  });

  it('any other error: its message from the catalog of errors, and the sheet stays', async () => {
    api.createOrder.mockRejectedValue(serverError({ status: 429, code: 'RATE_LIMITED' }));
    const user = userEvent.setup();
    const quoteControls = controls(ready('q1', '550000'));
    renderCheckout(flow(quoteControls));
    await screen.findByRole('dialog');
    await user.click(payButton());
    expect(await screen.findByText(/So‘rovlar juda ko‘p/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(quoteControls.discard).not.toHaveBeenCalled();
  });
});

describe('in the Mini App', () => {
  function tgFlow(webApp: ReturnType<typeof createFakeWebApp>, quoteControls: QuoteControls) {
    return (
      <TelegramContext.Provider value={{ phase: 'telegram', webApp }}>
        {flow(quoteControls, vi.fn(), 'tg')}
      </TelegramContext.Provider>
    );
  }

  it("Telegram's MainButton pays, with progress while the request runs, and the sheet draws no button", async () => {
    let finish: (value: { order: OrderDto }) => void = () => undefined;
    api.createOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const app = createFakeWebApp();
    window.Telegram = { WebApp: app };
    renderCheckout(tgFlow(app, controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: /^To‘lash · / })).toBeNull();
    expect(app.MainButton.setText).toHaveBeenLastCalledWith(
      expect.stringMatching(/To‘lash · 5.500\s*so‘m/),
    );
    expect(app.MainButton.enable).toHaveBeenCalled();

    act(() => app.pressMain());
    await waitFor(() => expect(app.MainButton.showProgress).toHaveBeenCalled());
    // a second press while it runs is ignored
    act(() => app.pressMain());
    expect(api.createOrder).toHaveBeenCalledTimes(1);

    await act(() => {
      finish({ order: ORDER });
      return Promise.resolve();
    });
    await waitFor(() => expect(api.push).toHaveBeenCalledWith('/tg/orders/order_1'));
    expect(app.HapticFeedback.notificationOccurred).toHaveBeenCalledWith('success');
    delete window.Telegram;
  });

  it('a refusal gives the error haptic', async () => {
    api.createOrder.mockRejectedValue(serverError({ status: 500, code: 'INTERNAL_ERROR' }));
    const app = createFakeWebApp();
    window.Telegram = { WebApp: app };
    renderCheckout(tgFlow(app, controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    act(() => app.pressMain());
    await waitFor(() =>
      expect(app.HapticFeedback.notificationOccurred).toHaveBeenCalledWith('error'),
    );
    delete window.Telegram;
  });
});
