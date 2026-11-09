import type { WalletResponse } from '@repo/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { renderApp } from '../../auth/__tests__/test-utils';
import { AnimatedMoney } from '../AnimatedMoney';
import { WalletCard } from '../WalletCard';

const mocks = vi.hoisted(() => ({
  getWallet: vi.fn(),
  // The support link comes from env; the tests change it per case.
  env: {
    NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
    NEXT_PUBLIC_API_MOCKS: [] as string[],
    NEXT_PUBLIC_SUPPORT_URL: '',
  },
}));
vi.mock('../../../env', () => ({ env: mocks.env }));
vi.mock('../../../lib/api/me', () => ({
  getWallet: mocks.getWallet,
  getMe: vi.fn(),
}));

const WALLET: WalletResponse = { balanceTiyin: '8540000', coins: '120', currency: 'UZS' };
// The group separator of formatMoney is a narrow no-break space; any single character matches.
const amount = (text: string) => new RegExp(text.replace(' ', '.'));

beforeEach(() => {
  mocks.getWallet.mockReset();
  mocks.env.NEXT_PUBLIC_SUPPORT_URL = '';
});
afterEach(() => {
  delete window.Telegram;
  delete document.documentElement.dataset.reduced;
});

describe('AnimatedMoney', () => {
  const reduce = () => {
    document.documentElement.dataset.reduced = 'true';
  };

  it('shows the server amount, laid out in the locale', () => {
    const { container, unmount } = renderApp(<AnimatedMoney tiyin="8540000" />);
    expect(container).toHaveTextContent(amount('85 400'));
    unmount();
    const ru = renderApp(<AnimatedMoney tiyin="8540000" />, { locale: 'ru' });
    expect(ru.container).toHaveTextContent(amount('85 400'));
  });

  it('with reduced motion a new value appears at once, well before an animation would end', async () => {
    reduce();
    const { container, rerender } = renderApp(<AnimatedMoney tiyin="8540000" />);
    rerender(<AnimatedMoney tiyin="9540000" />);
    // The text is drawn on the next frame; the animation would take about 0.7 s.
    await waitFor(() => expect(container).toHaveTextContent(amount('95 400')), { timeout: 250 });
  });

  it('otherwise it counts to the new value and rests on it exactly', async () => {
    const { container, rerender } = renderApp(<AnimatedMoney tiyin="8540000" />);
    rerender(<AnimatedMoney tiyin="9540012" />);
    // It ends on the server's number, cent for cent, not near it.
    await waitFor(() => expect(container).toHaveTextContent(amount('95 400,12')), {
      timeout: 4000,
    });
  });

  it('counts down as well, and a negative balance keeps its minus', async () => {
    reduce();
    const { container, rerender } = renderApp(<AnimatedMoney tiyin="8540000" />);
    rerender(<AnimatedMoney tiyin="-120000" />);
    await waitFor(() => expect(container).toHaveTextContent(/−1.200/), { timeout: 250 });
  });

  it('an amount above 2^53 tiyin is shown exactly, without animation', () => {
    const { container } = renderApp(<AnimatedMoney tiyin="900719925474099300" />);
    expect(container).toHaveTextContent(/9.007.199.254.740.993/);
  });

  it('a value that is not a tiyin string is a dash, never a zero', () => {
    const { container } = renderApp(<AnimatedMoney tiyin="12.5" />);
    expect(container).toHaveTextContent('—');
    expect(container).not.toHaveTextContent('0');
  });
});

describe('WalletCard', () => {
  it('loading: a placeholder with a status text', async () => {
    let finish: (value: WalletResponse) => void = () => undefined;
    mocks.getWallet.mockReturnValue(new Promise<WalletResponse>((resolve) => (finish = resolve)));
    renderApp(<WalletCard />);
    expect(screen.getByRole('status')).toHaveTextContent('Balans yuklanmoqda');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    finish(WALLET);
    expect(await screen.findByTestId('wallet-balance')).toBeInTheDocument();
  });

  it('error: says so and retry asks again', async () => {
    mocks.getWallet.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }));
    mocks.getWallet.mockResolvedValue(WALLET);
    renderApp(<WalletCard />);
    expect(await screen.findByText('Balansni yuklab bo‘lmadi')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByTestId('wallet-balance')).toHaveTextContent(amount('85 400'));
    expect(mocks.getWallet).toHaveBeenCalledTimes(2);
  });

  it('balance: the server amount with the unit, and the label of the section', async () => {
    mocks.getWallet.mockResolvedValue(WALLET);
    renderApp(<WalletCard />);
    const balance = await screen.findByTestId('wallet-balance');
    expect(balance).toHaveTextContent(amount('85 400'));
    expect(balance).toHaveTextContent('so‘m');
    expect(screen.getByRole('region', { name: 'Hamyon' })).toBeInTheDocument();
  });

  it('Russian: the unit and the buttons are in Russian', async () => {
    mocks.getWallet.mockResolvedValue(WALLET);
    renderApp(<WalletCard />, { locale: 'ru' });
    const balance = await screen.findByTestId('wallet-balance');
    expect(balance).toHaveTextContent('сум');
    expect(screen.getByRole('link', { name: /Пополнить счёт/ })).toHaveAttribute(
      'href',
      '/tg/topup',
    );
    expect(screen.getByRole('link', { name: /Помощь/ })).toHaveAttribute('href', '/tg/help');
  });

  it('top-up leads to /tg/topup; the bonus code is shown, marked "Tez orada", and does nothing when pressed', async () => {
    mocks.getWallet.mockResolvedValue(WALLET);
    renderApp(<WalletCard />);
    await screen.findByTestId('wallet-balance');
    const topUp = screen.getByRole('link', { name: /Hisobni to‘ldirish/ });
    expect(topUp).toHaveAttribute('href', '/tg/topup');
    expect(topUp).not.toHaveTextContent('Tez orada');
    const bonus = screen.getByRole('button', { name: /Bonus kod/ });
    expect(bonus).toHaveAttribute('aria-disabled', 'true');
    expect(bonus).toHaveTextContent('Tez orada');
    await userEvent.click(bonus);
    // Nothing was requested by that press.
    expect(mocks.getWallet).toHaveBeenCalledTimes(1);
  });

  it('Yordam leads to the Mini App’s own help screen, whatever support link is configured', async () => {
    mocks.getWallet.mockResolvedValue(WALLET);
    renderApp(<WalletCard />);
    await screen.findByTestId('wallet-balance');
    const help = screen.getByRole('link', { name: /Yordam/ });
    expect(help).toHaveAttribute('href', '/tg/help');
    expect(help).not.toHaveTextContent('Tez orada');
    expect(help).not.toHaveAttribute('target');
  });

  it('shows a new balance when the wallet is refetched', async () => {
    mocks.getWallet.mockResolvedValueOnce(WALLET);
    mocks.getWallet.mockResolvedValue({ ...WALLET, balanceTiyin: '1000000' });
    document.documentElement.dataset.reduced = 'true';
    const { client } = renderApp(<WalletCard />);
    await screen.findByTestId('wallet-balance');
    await client.invalidateQueries({ queryKey: ['wallet'] });
    await waitFor(() =>
      expect(screen.getByTestId('wallet-balance')).toHaveTextContent(amount('10 000')),
    );
  });
});
