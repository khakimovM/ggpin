import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import {
  PREMIUM,
  STARS,
  TOKEN,
  buyButtons,
  confirmRecipient,
  expectBuy,
  open,
  resetApi,
} from './product-test-kit';

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
// The quote's lifetime is a constant of the shared package; a test shortens it by setting `ttl.ms`.
const ttl = vi.hoisted(() => ({ ms: 600_000 }));
vi.mock('@repo/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@repo/shared')>();
  return Object.defineProperty({ ...original }, 'QUOTE_TTL_MS', {
    get: () => ttl.ms,
    enumerable: true,
  });
});
vi.mock('../../../lib/api/me', () => ({ getMe: api.getMe, getWallet: api.getWallet }));

beforeEach(() => {
  resetApi(api);
  ttl.ms = 600_000;
});

describe('the price', () => {
  it('503 PRICE_UNAVAILABLE: no price, a message and a retry that gets one', async () => {
    api.createQuote.mockRejectedValueOnce(new ApiError({ status: 503, code: 'PRICE_UNAVAILABLE' }));
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);
    expect(await screen.findByText('Narx hozircha mavjud emas')).toBeInTheDocument();
    expectBuy(false);

    const alert = screen.getByText('Narx hozircha mavjud emas').closest('[role="alert"]');
    if (!(alert instanceof HTMLElement)) throw new Error('no alert');
    await user.click(within(alert).getByRole('button', { name: 'Qayta urinish' }));
    await waitFor(() => expectBuy(true));
  });

  it('an expired quote turns the button off and offers "Narxni yangilash"', async () => {
    ttl.ms = 1200;
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);
    await waitFor(() => expectBuy(true));
    expect(await screen.findAllByText('Narx eskirdi', {}, { timeout: 4000 })).not.toHaveLength(0);
    expectBuy(false);
    // Not renewed on its own:
    expect(api.createQuote).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Narxni yangilash' }));
    await waitFor(() => expectBuy(true));
    expect(api.createQuote).toHaveBeenCalledTimes(2);
  });
});

describe('buying Premium', () => {
  beforeEach(() => api.getProduct.mockResolvedValue(PREMIUM));

  it('lists the terms as the catalog labels them and quotes the chosen package', async () => {
    const user = userEvent.setup();
    open('telegram-premium');
    const group = await screen.findByRole('radiogroup', { name: 'Muddat' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual([
      expect.stringContaining('3 oylik'),
      expect.stringContaining('6 oylik'),
      expect.stringContaining('12 oylik'),
    ]);
    await confirmRecipient(user);
    // Nothing chosen yet: no quote, and the button says what is missing.
    expect(api.createQuote).not.toHaveBeenCalled();
    expect(buyButtons()[0]).toHaveTextContent('Paketni tanlang');

    await user.click(within(group).getByRole('radio', { name: /6 oylik/ }));
    await waitFor(() => expect(api.createQuote).toHaveBeenCalledTimes(1));
    expect(api.createQuote.mock.calls[0]?.[0]).toEqual({
      productId: 'p_premium',
      skuId: 'm6',
      recipientToken: TOKEN,
    });
    await waitFor(() => expectBuy(true));
  });

  it('arrow keys move the choice', async () => {
    const user = userEvent.setup();
    open('telegram-premium');
    const group = await screen.findByRole('radiogroup', { name: 'Muddat' });
    await user.click(within(group).getByRole('radio', { name: /3 oylik/ }));
    await user.keyboard('{ArrowDown}');
    expect(within(group).getByRole('radio', { name: /6 oylik/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /6 oylik/ })).toHaveFocus();
  });

  it('in Russian the labels and the messages are Russian', async () => {
    open('telegram-premium', 'ru');
    expect(await screen.findByRole('radiogroup', { name: 'Срок' })).toBeVisible();
    expect(screen.getByText('Кому отправляем?')).toBeInTheDocument();
    expect(buyButtons()[0]).toBeDisabled();
  });
});

describe('"Qanday topaman?"', () => {
  it('opens the catalog text as plain text, never as HTML', async () => {
    const hostile = '<img src=x onerror="alert(1)"> 1-qadam\n<b>2-qadam</b>';
    api.getProduct.mockResolvedValue({ ...STARS, help: hostile });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Qanday topaman?' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('<img src=x onerror="alert(1)"> 1-qadam')).toBeInTheDocument();
    expect(within(dialog).getByText('<b>2-qadam</b>')).toBeInTheDocument();
    expect(dialog.querySelector('img, b')).toBeNull();
  });

  it('is not offered when the catalog has no help text', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    expect(screen.queryByRole('button', { name: 'Qanday topaman?' })).toBeNull();
  });
});

describe('answers that say the page is out of date', () => {
  const EXPIRED_NOTE = 'Tasdiq muddati tugadi. Qabul qiluvchini qayta tekshiring.';

  it('a stale price refreshed with a dead recipient token sends the visitor back to confirm again', async () => {
    ttl.ms = 1200;
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);
    await waitFor(() => expectBuy(true));
    await screen.findAllByText('Narx eskirdi', {}, { timeout: 4000 });

    // The server no longer knows the token (it lives 10 minutes, the quote a little longer).
    api.createQuote.mockRejectedValueOnce(new ApiError({ status: 422, code: 'RECIPIENT_INVALID' }));
    await user.click(screen.getByRole('button', { name: 'Narxni yangilash' }));

    expect(await screen.findByText(EXPIRED_NOTE)).toBeInTheDocument();
    // Not "Tasdiqlandi": the person is to be looked up and confirmed again; the username stays.
    expect(screen.queryByRole('img', { name: 'Tasdiqlandi' })).toBeNull();
    expect(screen.getByRole('textbox', { name: /username/i })).toHaveValue('aziz_k');
    expect(screen.getByText('Tasdiqlanmagan')).toBeInTheDocument();
    expectBuy(false);
    expect(buyButtons()[0]).toHaveTextContent('Avval qabul qiluvchini tasdiqlang');
    // One request for the refresh, and none by itself afterwards (no dead-end retry loop).
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(api.createQuote).toHaveBeenCalledTimes(2);

    // The way out: look up, confirm, and the price comes with the NEW token.
    await user.click(screen.getByRole('button', { name: 'Tekshirish' }));
    await user.click(await screen.findByRole('button', { name: 'Ha, shu' }));
    await waitFor(() => expectBuy(true));
    expect(api.validateRecipient).toHaveBeenCalledTimes(2);
    expect(api.createQuote).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(EXPIRED_NOTE)).toBeNull();
  });

  it('QTY_OUT_OF_RANGE: the product is loaded again, and the page follows the new range', async () => {
    api.getProduct.mockResolvedValueOnce(STARS).mockResolvedValueOnce({ ...STARS, minQty: 100 });
    api.createQuote.mockRejectedValueOnce(new ApiError({ status: 422, code: 'QTY_OUT_OF_RANGE' }));
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);

    await waitFor(() => expect(api.getProduct).toHaveBeenCalledTimes(2));
    // The untouched quantity follows the new minimum, and that one is priced.
    await waitFor(() => expectBuy(true));
    expect(screen.getByRole('textbox', { name: 'Stars miqdori' })).toHaveValue('100');
    expect(api.createQuote.mock.calls[1]?.[0]).toMatchObject({ quantity: 100 });
  });

  it('PRODUCT_UNAVAILABLE: the product is loaded again and the page says it is unavailable', async () => {
    api.getProduct.mockResolvedValueOnce(STARS).mockResolvedValueOnce({ ...STARS, stock: 0 });
    api.createQuote.mockRejectedValueOnce(
      new ApiError({ status: 422, code: 'PRODUCT_UNAVAILABLE' }),
    );
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);
    expect(await screen.findByText('Mahsulot vaqtincha mavjud emas')).toBeInTheDocument();
    expect(api.getProduct).toHaveBeenCalledTimes(2);
  });

  it('a 429 on the recipient check keeps "Qayta urinish" off until Retry-After has passed', async () => {
    api.validateRecipient.mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 }),
    );
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByRole('textbox', { name: /username/i }), 'aziz_k');
    await user.click(screen.getByRole('button', { name: 'Tekshirish' }));
    const retry = await screen.findByRole('button', { name: /^Qayta urinish/ });
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent(/\(\d+\)/);
    expect(api.validateRecipient).toHaveBeenCalledTimes(1);
  });
});

describe('the way to checkout', () => {
  it('"Sotib olish" opens the confirmation of the live quote, with the item and the person', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);
    await waitFor(() => expectBuy(true));
    await user.click(buyButtons()[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
    expect(dialog).toHaveTextContent('Telegram Stars · 50 ⭐');
    expect(dialog).toHaveTextContent('@aziz_k · Aziz');
    expect(dialog).toHaveTextContent(/Jami\s*5.500\s*so‘m/);
  });

  it('a button that is off opens nothing', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await user.click(buyButtons()[0] as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
