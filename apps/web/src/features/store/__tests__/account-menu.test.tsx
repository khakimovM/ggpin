import type { Me, WalletResponse } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { renderApp } from '../../auth/__tests__/test-utils';
import { AccountMenu } from '../AccountMenu';
import { WalletPill } from '../WalletPill';

const mocks = vi.hoisted(() => ({ getMe: vi.fn(), getWallet: vi.fn(), logout: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/store',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('../../../lib/api/me', () => ({ getMe: mocks.getMe, getWallet: mocks.getWallet }));
vi.mock('../../auth/use-logout', () => ({ useLogout: () => ({ mutate: mocks.logout }) }));

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
const WALLET: WalletResponse = { balanceTiyin: '8540000', coins: '0', currency: 'UZS' };

beforeEach(() => {
  mocks.getMe.mockReset().mockResolvedValue(ME);
  mocks.getWallet.mockReset().mockResolvedValue(WALLET);
  mocks.logout.mockReset();
});

function menu() {
  return renderApp(
    <ThemeProvider variant="web">
      <button type="button">outside</button>
      <AccountMenu />
      <button type="button">after</button>
    </ThemeProvider>,
  );
}
const button = () => screen.getByRole('button', { name: 'Hisob menyusi' });

describe('AccountMenu', () => {
  it('opens and closes with its button', async () => {
    menu();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button());
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('@sardor_r')).toBeInTheDocument();
    await userEvent.click(button());
    expect(button()).toHaveAttribute('aria-expanded', 'false');
  });

  it('Tab moving focus inside the panel keeps it open', async () => {
    menu();
    await userEvent.click(button());
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Profil' })).toHaveFocus();
    expect(button()).toHaveAttribute('aria-expanded', 'true');
  });

  it('focus leaving for another element outside closes it', async () => {
    menu();
    await userEvent.click(button());
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    act(() => screen.getByRole('button', { name: 'outside' }).focus());
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Profil' })).not.toBeInTheDocument();
  });

  it('tabbing out through the last item, to what follows the menu, closes it', async () => {
    menu();
    await userEvent.click(button());
    // Panel items: Profil, (language and theme, hidden from 1024 px in the browser, here present),
    // Chiqish; then the page continues with the "after" button.
    for (let step = 0; step < 6; step += 1) {
      await userEvent.tab();
      if (screen.getByRole('button', { name: 'after' }) === document.activeElement) break;
    }
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a press on the profile link works: focus moving onto it (or nowhere, as in Safari) keeps the menu open until the click', async () => {
    menu();
    await userEvent.click(button());
    const link = screen.getByRole('link', { name: 'Profil' });
    // Browsers that focus a link on press: the focus goes from the button to the link.
    act(() => link.focus());
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    // Browsers that do not (Safari, touch): the button blurs to nothing.
    act(() => button().focus());
    fireEvent.blur(button(), { relatedTarget: null });
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    // The click itself reaches the link, and only then does the menu close.
    const clicked = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicked);
    await userEvent.click(link);
    expect(clicked).toHaveBeenCalledOnce();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape closes it and gives the focus back to the button', async () => {
    menu();
    await userEvent.click(button());
    await userEvent.tab();
    await userEvent.keyboard('{Escape}');
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    expect(button()).toHaveFocus();
  });

  it('a pointer press outside closes it', async () => {
    menu();
    await userEvent.click(button());
    await userEvent.click(document.body);
    expect(button()).toHaveAttribute('aria-expanded', 'false');
  });

  it('the sign-out item signs out', async () => {
    menu();
    await userEvent.click(button());
    await userEvent.click(screen.getByRole('button', { name: 'Chiqish' }));
    expect(mocks.logout).toHaveBeenCalledOnce();
  });
});

describe('WalletPill', () => {
  it('shows the server balance', async () => {
    renderApp(<WalletPill />);
    expect(await screen.findByTestId('header-balance')).toHaveTextContent(/85.400/);
  });

  it('an error shows a dash and a retry, never a number', async () => {
    mocks.getWallet.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }));
    renderApp(<WalletPill />);
    const retry = await screen.findByRole('button', {
      name: 'Balansni yuklab bo‘lmadi. Qayta urinish',
    });
    expect(retry).toHaveTextContent('—');
    expect(screen.queryByTestId('header-balance')).not.toBeInTheDocument();
    await userEvent.click(retry);
    expect(await screen.findByTestId('header-balance')).toHaveTextContent(/85.400/);
  });
});
