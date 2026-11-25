import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { buyButtons, expectBuy, open, resetApi } from './product-test-kit';

// CR #7 (one canonical username on every surface) and N8 (a 429 is "busy", with a countdown).

const api = vi.hoisted(() => ({
  getProduct: vi.fn(),
  validateRecipient: vi.fn(),
  createQuote: vi.fn(),
  getMe: vi.fn(),
  getWallet: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('../../../lib/api/catalog', () => ({ getProduct: api.getProduct }));
vi.mock('../../../lib/api/recipients', () => ({ validateRecipient: api.validateRecipient }));
vi.mock('../../../lib/api/quotes', () => ({ createQuote: api.createQuote }));
vi.mock('../../../lib/api/me', () => ({ getMe: api.getMe, getWallet: api.getWallet }));

const BUSY = 'Tekshiruv hozir band. Bir oz kutib, qayta urinib ko‘ring.';
const DOWN = 'Tekshirib bo‘lmadi. Birozdan so‘ng qayta urinib ko‘ring.';

beforeEach(() => {
  resetApi(api);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a 429 from the recipient check', () => {
  it('says busy, keeps the button off with a countdown, and turns it on when the time is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.validateRecipient.mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 3 }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    open();
    await user.type(await screen.findByRole('textbox', { name: /username/i }), 'aziz_k');
    await user.click(screen.getByRole('button', { name: 'Tekshirish' }));

    expect(await screen.findByText(BUSY)).toBeInTheDocument();
    expect(screen.queryByText(DOWN)).toBeNull();
    const retry = screen.getByRole('button', { name: /^Qayta urinish/ });
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent(/\((1|2|3)\)/);
    // The main "Tekshirish" is off for the same wait (a tap would do nothing).
    const main = screen.getByRole('button', { name: 'Tekshirish' });
    expect(main).toBeDisabled();
    // Only the message is a live region, so the ticking button is not read out every second.
    expect(screen.getByRole('alert')).toHaveTextContent(BUSY);
    expect(screen.getByRole('alert')).not.toContainElement(retry);
    expect(api.validateRecipient).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(main).toBeEnabled();
    expect(retry).toHaveTextContent(/^Qayta urinish$/);
    // Nothing was sent again by itself.
    expect(api.validateRecipient).toHaveBeenCalledTimes(1);

    api.validateRecipient.mockResolvedValue({
      recipientToken: 'R'.repeat(43),
      displayName: 'Aziz',
      warnings: [],
    });
    await user.click(retry);
    expect(await screen.findByRole('button', { name: 'Ha, shu' })).toBeInTheDocument();
    expect(api.validateRecipient).toHaveBeenCalledTimes(2);
  });

  it('in Russian too, with its own text', async () => {
    api.validateRecipient.mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 }),
    );
    const user = userEvent.setup();
    open('telegram-stars', 'ru');
    await user.type(await screen.findByRole('textbox', { name: /username/i }), 'aziz_k');
    await user.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(
      await screen.findByText('Проверка сейчас занята. Подождите немного и попробуйте снова.'),
    ).toBeInTheDocument();
  });
});

describe('one canonical username', () => {
  it('Aziz_K is typed as is, sent as aziz_k and shown as @aziz_k on the cards, the summary and checkout', async () => {
    const user = userEvent.setup();
    open();
    const field = await screen.findByRole('textbox', { name: /username/i });
    await user.type(field, 'Aziz_K');
    // The field shows what the visitor typed; nothing was lower-cased under the cursor.
    expect(field).toHaveValue('Aziz_K');
    await user.click(screen.getByRole('button', { name: 'Tekshirish' }));
    expect(api.validateRecipient.mock.calls[0]?.[0]).toEqual({
      productId: 'p_stars',
      input: { username: 'aziz_k' },
    });

    await screen.findByRole('button', { name: 'Ha, shu' });
    expect(screen.getByText('@aziz_k')).toBeInTheDocument();
    expect(screen.queryByText(/Aziz_K/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Ha, shu' }));
    const summary = await screen.findByRole('region', { name: 'Buyurtma xulosasi' });
    await waitFor(() => expect(within(summary).getByText('@aziz_k')).toBeInTheDocument());
    expect(screen.getAllByText('@aziz_k').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Aziz_K/)).toBeNull();

    await waitFor(() => expectBuy(true));
    await user.click(buyButtons()[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
    expect(dialog).toHaveTextContent('@aziz_k · Aziz');
    expect(dialog).not.toHaveTextContent('Aziz_K');
  });

  it('"O‘zim" is hidden when the field already names the visitor in another spelling', async () => {
    const user = userEvent.setup();
    open();
    const field = await screen.findByRole('textbox', { name: /username/i });
    // Positive control: the shortcut is there before (the visitor's profile has loaded).
    expect(await screen.findByRole('button', { name: 'O‘zim' })).toBeInTheDocument();
    await user.type(field, 'Sardor_R');
    expect(screen.queryByRole('button', { name: 'O‘zim' })).toBeNull();
  });
});
