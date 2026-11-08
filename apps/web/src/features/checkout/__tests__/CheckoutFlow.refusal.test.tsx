import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { getAttempt, resetOrderAttempts } from '../../../lib/order-attempts';
import { createFakeWebApp } from '../../../telegram/__tests__/fake-webapp';
import { TelegramContext } from '../../../telegram/telegram-context';
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
const checkButton = () => screen.findByRole('button', { name: 'Qayta tekshirish' });

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

describe('a refusal while the doubt stands', () => {
  it('a frozen account shows the frozen sheet WITH the reminder, and the record stays', async () => {
    const { user } = await loseTheAnswer();
    api.createOrder.mockRejectedValueOnce(serverError({ status: 403, code: 'PURCHASE_FROZEN' }));
    await user.click(await checkButton());
    const sheet = await screen.findByRole('dialog', { name: 'Xaridlar vaqtincha cheklangan' });
    expect(sheet).toHaveTextContent('Avvalgi to‘lovingiz natijasi hali nomaʼlum');
    expect(getAttempt(USER_ID)?.quoteId).toBe('q1');
  });

  it('a frozen account on a clean first press has no such reminder', async () => {
    api.createOrder.mockRejectedValueOnce(serverError({ status: 403, code: 'PURCHASE_FROZEN' }));
    const user = userEvent.setup();
    renderCheckout(flow(controls(ready('q1', '550000'))));
    await screen.findByRole('dialog');
    await user.click(payButton());
    const sheet = await screen.findByRole('dialog', { name: 'Xaridlar vaqtincha cheklangan' });
    expect(sheet).not.toHaveTextContent('nomaʼlum');
    expect(getAttempt(USER_ID)).toBeNull();
  });

  it('a 429 on the check disables it for Retry-After seconds, then it works again', async () => {
    const { user } = await loseTheAnswer();
    api.createOrder.mockRejectedValueOnce(
      serverError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 1 }),
    );
    await user.click(await checkButton());
    const waiting = await screen.findByRole('button', { name: /soniyadan keyin qayta tekshirish/ });
    expect(waiting).toBeDisabled();
    expect(getAttempt(USER_ID)?.quoteId).toBe('q1');
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Qayta tekshirish' })).toBeEnabled(),
      {
        timeout: 4000,
      },
    );
  });
});

describe('in the Mini App (the check is on the MainButton)', () => {
  async function loseInTelegram(quoteControls = controls(ready('q1', '550000'))) {
    const app = createFakeWebApp();
    window.Telegram = { WebApp: app };
    api.createOrder.mockRejectedValueOnce(LOST());
    renderCheckout(
      <TelegramContext.Provider value={{ phase: 'telegram', webApp: app }}>
        {flow(quoteControls, vi.fn(), 'tg')}
      </TelegramContext.Provider>,
    );
    await screen.findByRole('dialog');
    act(() => app.pressMain());
    await waitFor(() =>
      expect(app.MainButton.setText).toHaveBeenLastCalledWith('Qayta tekshirish'),
    );
    return { app, quoteControls };
  }

  it("the API's own 404 means there is no order: the doubt ends and a new price is fetched", async () => {
    const { app, quoteControls } = await loseInTelegram();
    api.createOrder.mockRejectedValueOnce(serverError({ status: 404, code: 'NOT_FOUND' }));
    act(() => app.pressMain());
    await waitFor(() => expect(quoteControls.refresh).toHaveBeenCalledTimes(1));
    expect(getAttempt(USER_ID)).toBeNull();
    delete window.Telegram;
  });

  it("a proxy's HTML 404 proves nothing: the doubt stays and the next check uses the same key", async () => {
    const { app, quoteControls } = await loseInTelegram();
    api.createOrder.mockRejectedValueOnce(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    act(() => app.pressMain());
    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(2));
    expect(quoteControls.refresh).not.toHaveBeenCalled();
    expect(getAttempt(USER_ID)?.quoteId).toBe('q1');
    api.createOrder.mockResolvedValue({ order: ORDER });
    await waitFor(() => expect(app.MainButton.enable).toHaveBeenCalled());
    act(() => app.pressMain());
    await waitFor(() => expect(api.push).toHaveBeenCalledWith('/tg/orders/order_1'));
    expect(api.createOrder.mock.calls[2]?.[1]).toBe(api.createOrder.mock.calls[0]?.[1]);
    delete window.Telegram;
  });
});
