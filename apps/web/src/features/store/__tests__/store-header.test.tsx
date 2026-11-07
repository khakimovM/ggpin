import type { Me, WalletResponse } from '@repo/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCatalogSearchStore } from '../../../stores/catalog-search-store';
import { renderApp } from '../../auth/__tests__/test-utils';
import { ProfileRow } from '../../catalog/ProfileRow';
import { SearchBox } from '../../catalog/SearchBox';

const nav = vi.hoisted(() => ({
  pathname: '/store',
  search: '',
  replace: vi.fn(),
  push: vi.fn(),
  getMe: vi.fn(),
  getWallet: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('../../../lib/api/me', () => ({ getMe: nav.getMe, getWallet: nav.getWallet }));

const ME: Me = {
  id: 'u1',
  telegramId: '1',
  username: 'sardor_r',
  firstName: 'Sardor',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'R1',
  phoneLinked: false,
};
const wallet = (coins: string): WalletResponse => ({ balanceTiyin: '0', coins, currency: 'UZS' });

beforeEach(() => {
  nav.pathname = '/store';
  nav.search = '';
  nav.replace.mockReset();
  nav.push.mockReset();
  nav.getMe.mockReset().mockResolvedValue(ME);
  nav.getWallet.mockReset().mockResolvedValue(wallet('120'));
  useCatalogSearchStore.setState({ text: '' });
});

describe('ProfileRow', () => {
  it('the name is the page heading, with the username and the coins', async () => {
    renderApp(<ProfileRow />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sardor' })).toBeInTheDocument();
    expect(screen.getByText('@sardor_r')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Keshbek: 120 tanga' })).toBeInTheDocument();
  });

  it('Russian coins use the right plural form', async () => {
    const cases: [string, string][] = [
      ['1', 'Кешбэк: 1 монета'],
      ['3', 'Кешбэк: 3 монеты'],
      ['5', 'Кешбэк: 5 монет'],
      ['21', 'Кешбэк: 21 монета'],
    ];
    for (const [coins, label] of cases) {
      nav.getWallet.mockResolvedValue(wallet(coins));
      const { unmount } = renderApp(<ProfileRow />, { locale: 'ru' });
      expect(await screen.findByRole('img', { name: label })).toBeInTheDocument();
      unmount();
    }
  });

  it('without a first name the username is the heading; without either, the brand', async () => {
    nav.getMe.mockResolvedValue({ ...ME, firstName: null });
    const first = renderApp(<ProfileRow />);
    expect(await screen.findByRole('heading', { level: 1, name: 'sardor_r' })).toBeInTheDocument();
    first.unmount();
    nav.getMe.mockResolvedValue({ ...ME, firstName: null, username: null });
    renderApp(<ProfileRow />);
    expect(await screen.findByRole('heading', { level: 1, name: 'ggpin' })).toBeInTheDocument();
    expect(screen.queryByText(/^@/)).not.toBeInTheDocument();
  });

  it('shows no coins until the wallet is there, and none if it cannot be loaded', async () => {
    nav.getWallet.mockRejectedValue(new Error('down'));
    renderApp(<ProfileRow />);
    await screen.findByRole('heading', { level: 1, name: 'Sardor' });
    expect(screen.queryByRole('img', { name: /Keshbek/ })).not.toBeInTheDocument();
  });
});

describe('SearchBox', () => {
  it('takes at most 64 characters, writes into the shared search, and clears', async () => {
    renderApp(<SearchBox />);
    const box = screen.getByRole('searchbox', { name: 'Mahsulot qidirish' });
    expect(box).toHaveAttribute('maxlength', '64');
    await userEvent.type(box, 'pubg');
    expect(useCatalogSearchStore.getState().text).toBe('pubg');
    await userEvent.click(screen.getByRole('button', { name: 'Tozalash' }));
    expect(useCatalogSearchStore.getState().text).toBe('');
    expect(box).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Tozalash' })).not.toBeInTheDocument();
  });

  it('two boxes (the header has one for each width) show the same text', async () => {
    renderApp(
      <>
        <SearchBox />
        <SearchBox compact />
      </>,
    );
    const [first, second] = screen.getAllByRole('searchbox');
    if (!first || !second) throw new Error('two boxes expected');
    await userEvent.type(first, 'steam');
    expect(second).toHaveValue('steam');
  });
});
