import { fireEvent, screen, waitFor } from '@testing-library/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logout } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/errors';
import { getMe } from '../../../lib/api/me';
import { hardNavigate } from '../../../lib/navigation';
import { useAuthUiStore } from '../../../stores/auth-ui-store';
import { AuthGuard } from '../AuthGuard';
import { LogoutButton } from '../LogoutButton';
import { renderApp } from './test-utils';

vi.mock('../../../lib/api/auth', () => ({ logout: vi.fn() }));
vi.mock('../../../lib/api/me', () => ({ getMe: vi.fn() }));
vi.mock('../../../lib/navigation', () => ({ hardNavigate: vi.fn() }));
// The sign-in link is built from the router's view of the URL, never from `window`.
vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useSearchParams: vi.fn() }));

function at(pathname: string, search = ''): void {
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(search) as never);
}

const ME = {
  id: 'user_1',
  telegramId: '123456789',
  username: 'sardor_r',
  firstName: 'Sardor',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'REF123',
  phoneLinked: false,
} as const;

const mockMe = vi.mocked(getMe);
const mockLogout = vi.mocked(logout);

function Page() {
  return (
    <div>
      <p>private page</p>
      <LogoutButton />
    </div>
  );
}

beforeEach(() => {
  mockMe.mockResolvedValue(ME);
  at('/store/profile');
  // A different address in the browser proves the link does not come from `window.location`.
  window.history.pushState({}, '', '/somewhere-else?x=1');
  useAuthUiStore.setState({ logout: 'idle' });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('AuthGuard: the gate', () => {
  it('shows a loading state, then the page once /me answered', async () => {
    renderApp(
      <AuthGuard>
        <Page />
      </AuthGuard>,
    );
    expect(screen.getByText('Sessiya tekshirilmoqda…')).toBeInTheDocument();
    expect(screen.queryByText('private page')).not.toBeInTheDocument();
    expect(await screen.findByText('private page')).toBeInTheDocument();
  });

  it('a session that ended shows the "Kirish" call to action, back to where the visitor was', async () => {
    mockMe.mockRejectedValue(new ApiError({ status: 401, code: 'UNAUTHORIZED' }));
    renderApp(
      <AuthGuard>
        <Page />
      </AuthGuard>,
    );
    expect(await screen.findByText('Sessiya yakunlangan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kirish' })).toHaveAttribute(
      'href',
      '/login?next=%2Fstore%2Fprofile',
    );
    expect(screen.queryByText('private page')).not.toBeInTheDocument();
  });

  it('the query string of the page travels in next', async () => {
    at('/store/profile', 'tab=orders');
    mockMe.mockRejectedValue(new ApiError({ status: 401, code: 'UNAUTHORIZED' }));
    renderApp(
      <AuthGuard>
        <Page />
      </AuthGuard>,
    );
    expect(await screen.findByRole('link', { name: 'Kirish' })).toHaveAttribute(
      'href',
      '/login?next=%2Fstore%2Fprofile%3Ftab%3Dorders',
    );
  });

  it('Russian: the link keeps the /ru prefix', async () => {
    at('/ru/store/profile');
    mockMe.mockRejectedValue(new ApiError({ status: 401, code: 'UNAUTHORIZED' }));
    renderApp(
      <AuthGuard>
        <Page />
      </AuthGuard>,
      { locale: 'ru' },
    );
    expect(await screen.findByText('Сеанс завершён')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute(
      'href',
      '/ru/login?next=%2Fru%2Fstore%2Fprofile',
    );
  });

  it('a blocked account gets the reason and no way to sign in again', async () => {
    mockMe.mockRejectedValue(new ApiError({ status: 403, code: 'USER_BLOCKED' }));
    renderApp(
      <AuthGuard>
        <Page />
      </AuthGuard>,
    );
    expect(await screen.findByText(/Hisobingiz bloklangan/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Kirish' })).not.toBeInTheDocument();
  });

  it('any other failure is an error with a retry, not a sign-in prompt', async () => {
    mockMe
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }))
      .mockResolvedValueOnce(ME);
    renderApp(
      <AuthGuard>
        <Page />
      </AuthGuard>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Internet bilan aloqa yo‘q');
    expect(screen.queryByRole('link', { name: 'Kirish' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByText('private page')).toBeInTheDocument();
  });
});

describe('logout through the guard', () => {
  async function openPage(locale: 'uz' | 'ru' = 'uz') {
    renderApp(
      <AuthGuard>
        <Page />
      </AuthGuard>,
      { locale },
    );
    await screen.findByText('private page');
  }

  it('success: a full navigation to the home page, and logout gets no arguments', async () => {
    mockLogout.mockResolvedValue(undefined);
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Chiqish' }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('/'));
    expect(mockLogout).toHaveBeenCalledWith();
  });

  it('success in Russian goes to /ru', async () => {
    mockLogout.mockResolvedValue(undefined);
    await openPage('ru');
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('/ru'));
  });

  it('while it runs the button is busy and the page does not claim the session ended', async () => {
    mockLogout.mockReturnValue(new Promise(() => undefined));
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Chiqish' }));
    const busy = await screen.findByRole('button', { name: 'Chiqilmoqda…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Sessiya yakunlangan')).not.toBeInTheDocument();
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  it('failure: "Chiqish amalga oshmadi" with a retry, never a signed-out screen or a navigation', async () => {
    mockLogout.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Chiqish' }));

    expect(await screen.findByText('Chiqish amalga oshmadi')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Hisobingiz hozircha ochiq qolgan');
    expect(screen.queryByText('Sessiya yakunlangan')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Kirish' })).not.toBeInTheDocument();
    expect(hardNavigate).not.toHaveBeenCalled();

    // The retry runs the same logout again and, this time, leaves the page.
    mockLogout.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('/'));
    expect(mockLogout).toHaveBeenCalledTimes(2);
  });

  it('failure stays on screen even after /me was reset by the local sign-out', async () => {
    mockLogout.mockImplementation(() => {
      // logout() signs the strategy out and drops the cache before it asks the server.
      mockMe.mockRejectedValue(new ApiError({ status: 401, code: 'UNAUTHORIZED' }));
      return Promise.reject(new ApiError({ status: 0, code: 'NETWORK' }));
    });
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Chiqish' }));
    expect(await screen.findByText('Chiqish amalga oshmadi')).toBeInTheDocument();
    expect(screen.queryByText('Sessiya yakunlangan')).not.toBeInTheDocument();
  });
});
