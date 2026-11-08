import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import {
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
vi.mock('../../../lib/api/catalog', () => ({ getProduct: api.getProduct }));
vi.mock('../../../lib/api/recipients', () => ({ validateRecipient: api.validateRecipient }));
vi.mock('../../../lib/api/quotes', () => ({ createQuote: api.createQuote }));
vi.mock('../../../lib/api/me', () => ({ getMe: api.getMe, getWallet: api.getWallet }));

beforeEach(() => {
  resetApi(api);
});

describe('the four states of the page', () => {
  it('loading: a skeleton with a status text', () => {
    api.getProduct.mockReturnValue(new Promise(() => undefined));
    open();
    expect(screen.getByRole('status')).toHaveTextContent('Mahsulot yuklanmoqda');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('error: a message and a retry that loads the page', async () => {
    api.getProduct.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    const user = userEvent.setup();
    open();
    expect(await screen.findByText('Maʼlumotni yuklab bo‘lmadi')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeVisible();
  });

  it('unavailable: a 404 says so and leads back to the catalog', async () => {
    api.getProduct.mockRejectedValue(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    open('nothing-here');
    expect(await screen.findByText('Mahsulot vaqtincha mavjud emas')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Katalogga qaytish' })).toHaveAttribute(
      'href',
      '/store',
    );
  });

  it('unavailable: sold out keeps the header but offers nothing to buy', async () => {
    api.getProduct.mockResolvedValue({ ...STARS, stock: 0 });
    open();
    expect(await screen.findByText('Mahsulot vaqtincha mavjud emas')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Telegram Stars' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sotib olish/ })).toBeNull();
  });

  it('unavailable: a product whose form this page cannot show is not sold', async () => {
    api.getProduct.mockResolvedValue({ ...STARS, inputSchema: [] });
    open();
    expect(await screen.findByText('Mahsulot vaqtincha mavjud emas')).toBeInTheDocument();
    expect(api.validateRecipient).not.toHaveBeenCalled();
  });
});

describe('buying Stars', () => {
  it('the buy button is off until the recipient is confirmed AND a quote is live', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    expectBuy(false);
    expect(buyButtons()[0]).toHaveTextContent('Avval qabul qiluvchini tasdiqlang');
    expect(api.createQuote).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: /username/i }), 'aziz_k');
    await user.click(screen.getByRole('button', { name: 'Tekshirish' }));
    // Found is not confirmed: still no price, still no buy.
    await screen.findByText('To‘g‘ri odammi? Tasdiqlang');
    expect(api.createQuote).not.toHaveBeenCalled();
    expectBuy(false);

    await user.click(screen.getByRole('button', { name: 'Ha, shu' }));
    await waitFor(() => expect(api.createQuote).toHaveBeenCalledTimes(1));
    expect(api.createQuote.mock.calls[0]?.[0]).toEqual({
      productId: 'p_stars',
      quantity: 50,
      recipientToken: TOKEN,
    });
    // The total is the server's string, laid out - not 50 times anything.
    await waitFor(() => expectBuy(true));
    expect(document.body).toHaveTextContent(/5.500\s*so‘m/);
  });

  it('changing the username takes the confirmation, the price and the button away', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);
    await waitFor(() => expectBuy(true));

    await user.click(screen.getByRole('button', { name: 'O‘zgartirish' }));
    expectBuy(false);
    expect(screen.getByText('Tasdiqlanmagan')).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: /username/i });
    await user.type(field, 'x');
    expect(screen.queryByText('Ha, shu')).toBeNull();
    expectBuy(false);
  });

  it('a quantity below the minimum is an error and asks for no price', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { level: 1, name: 'Telegram Stars' });
    await confirmRecipient(user);
    await waitFor(() => expect(api.createQuote).toHaveBeenCalledTimes(1));

    const qty = screen.getByRole('textbox', { name: 'Stars miqdori' });
    await user.clear(qty);
    await user.type(qty, '10');
    expect(await screen.findByText('50 dan 100 000 gacha ⭐ tanlang')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(api.createQuote).toHaveBeenCalledTimes(1);
    expectBuy(false);
    expect(buyButtons()[0]).toHaveTextContent('Paketni tanlang');
  });

  it('shows the per-unit price only as an approximation', async () => {
    open();
    expect(await screen.findByText(/Taxminan: 1 ⭐ ≈ 220 so‘m/)).toBeInTheDocument();
  });
});

describe('the recipient messages', () => {
  const cases: Array<[string, ApiError, string | RegExp]> = [
    [
      'not found',
      new ApiError({ status: 422, code: 'RECIPIENT_NOT_FOUND' }),
      'Bunday foydalanuvchi topilmadi. Usernameni tekshiring.',
    ],
    [
      'check is down',
      new ApiError({ status: 503, code: 'RECIPIENT_CHECK_UNAVAILABLE' }),
      'Tekshirib bo‘lmadi. Birozdan so‘ng qayta urinib ko‘ring.',
    ],
    [
      'premium blocked',
      new ApiError({ status: 422, code: 'RECIPIENT_HAS_PREMIUM' }),
      'Bu foydalanuvchiga hozir Premium sovg‘a qilib bo‘lmaydi',
    ],
  ];
  it.each(cases)('%s', async (_name, error, text) => {
    api.validateRecipient.mockRejectedValue(error);
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByRole('textbox', { name: /username/i }), 'aziz_k');
    await user.click(screen.getByRole('button', { name: 'Tekshirish' }));
    expect(await screen.findAllByText(text)).not.toHaveLength(0);
    expect(api.createQuote).not.toHaveBeenCalled();
    expectBuy(false);
  });

  it('a too-short username is rejected on the page, without a request', async () => {
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByRole('textbox', { name: /username/i }), 'dk');
    await user.click(screen.getByRole('button', { name: 'Tekshirish' }));
    expect(
      await screen.findByText('Username 5–32 ta lotin harf, raqam yoki _ dan iborat bo‘ladi'),
    ).toBeInTheDocument();
    expect(api.validateRecipient).not.toHaveBeenCalled();
  });

  it('"O‘zim" fills the visitor\'s own username', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'O‘zim' }));
    expect(screen.getByRole('textbox', { name: /username/i })).toHaveValue('sardor_r');
  });
});
