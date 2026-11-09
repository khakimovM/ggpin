import type { Locale, Me } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { getMe, getWallet, updateMe } from '../../../lib/api/me';
import { hardNavigate } from '../../../lib/navigation';
import { qk } from '../../../lib/query-keys';
import { useTgUiStore } from '../../../stores/tg-ui-store';
import { renderApp } from '../../auth/__tests__/test-utils';
import { LanguageSwitch } from '../../store/LanguageSwitch';
import { LanguagePicker } from '../LanguagePicker';
import { releaseLocaleLock } from '../use-change-locale';
import { TgProfile } from '../TgProfile';
import { WebProfile } from '../WebProfile';

// The language choice (PATCH /me) from the profile picker and from the store header switch: one
// hook behind both (useChangeLocale).

const mocks = vi.hoisted(() => ({ pathname: '/tg/profile' }));
vi.mock('../../../env', () => ({
  env: {
    NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_BOT_USERNAME: 'ggpin_test_bot',
    NEXT_PUBLIC_API_MOCKS: [] as string[],
    NEXT_PUBLIC_SUPPORT_URL: '',
  },
}));
vi.mock('../../../lib/api/me', () => ({ getMe: vi.fn(), getWallet: vi.fn(), updateMe: vi.fn() }));
vi.mock('../../../lib/api/auth', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  logout: vi.fn(),
}));
vi.mock('../../../lib/navigation', () => ({ hardNavigate: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));

const ME: Me = {
  id: 'user_1',
  telegramId: '1187712645',
  username: 'sardor_r',
  firstName: 'Sardor',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'sardor77',
  phoneLinked: false,
};

/** A client that already holds `/me`, like the app behind its sign-in gate. `null`: a guest. */
function mount(
  ui: ReactElement,
  { me = ME, locale = 'uz' }: { me?: Me | null; locale?: Locale } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  if (me !== null) client.setQueryData(qk.me(), me);
  return renderApp(<ThemeProvider variant="web">{ui}</ThemeProvider>, { locale, client });
}

// The first render of a big tree is the slow one (cold code, a loaded machine): it is paid once,
// here, with a timeout of its own, instead of making the first test of the file hit its 5 s limit.
beforeAll(async () => {
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(getWallet).mockResolvedValue({ balanceTiyin: '0', coins: '0', currency: 'UZS' });
  const view = mount(<TgProfile />);
  await screen.findByRole('radio', { name: 'Русский' }, { timeout: 25_000 });
  view.unmount();
}, 30_000);

beforeEach(() => {
  // The lock stays closed through a page load; there is no page load in a test.
  releaseLocaleLock();
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(getWallet).mockResolvedValue({ balanceTiyin: '0', coins: '0', currency: 'UZS' });
  vi.mocked(updateMe).mockReset();
  vi.mocked(hardNavigate).mockReset();
  mocks.pathname = '/tg/profile';
  useTgUiStore.setState({ locale: 'uz' });
});

describe('profile picker (Mini App)', () => {
  it('saves first, then switches the language of the screens', async () => {
    vi.mocked(updateMe).mockResolvedValue({ ...ME, locale: 'ru' });
    mount(<TgProfile />);
    expect(screen.getByRole('radio', { name: 'O‘zbekcha' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    expect(updateMe).toHaveBeenCalledWith({ locale: 'ru' });
    await waitFor(() => expect(useTgUiStore.getState().locale).toBe('ru'));
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  it('keeps the old language and says so when the server refuses', async () => {
    vi.mocked(updateMe).mockRejectedValue(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }));
    mount(<TgProfile />);
    await userEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tilni o‘zgartirib bo‘lmadi');
    expect(useTgUiStore.getState().locale).toBe('uz');
  });

  it('choosing the language that is on screen AND saved does not call the API', async () => {
    mount(<TgProfile />);
    await userEvent.click(screen.getByRole('radio', { name: 'O‘zbekcha' }));
    expect(updateMe).not.toHaveBeenCalled();
  });

  it('arrow keys move through the two languages', async () => {
    vi.mocked(updateMe).mockResolvedValue({ ...ME, locale: 'ru' });
    mount(<TgProfile />);
    screen.getByRole('radio', { name: 'O‘zbekcha' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(updateMe).toHaveBeenCalledWith({ locale: 'ru' });
  });

  it('two quick presses save once; the pills are aria-disabled and keep the focus meanwhile', async () => {
    let finish: (me: Me) => void = () => undefined;
    vi.mocked(updateMe).mockReturnValue(new Promise<Me>((resolve) => (finish = resolve)));
    mount(<TgProfile />);
    const ru = screen.getByRole('radio', { name: 'Русский' });
    ru.focus();
    await userEvent.dblClick(ru);
    expect(updateMe).toHaveBeenCalledTimes(1);
    expect(ru).toHaveAttribute('aria-disabled', 'true');
    expect(ru).not.toBeDisabled();
    expect(ru).toHaveFocus();
    await act(() => {
      finish({ ...ME, locale: 'ru' });
      return Promise.resolve();
    });
    await waitFor(() => expect(ru).toHaveAttribute('aria-disabled', 'false'));
  });
});

describe('profile picker (web)', () => {
  beforeEach(() => {
    mocks.pathname = '/store/profile';
  });

  it('after saving, loads the same page under the other language prefix', async () => {
    vi.mocked(updateMe).mockResolvedValue({ ...ME, locale: 'ru' });
    mount(<WebProfile />);
    await userEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/ru/store/profile'));
    expect(updateMe).toHaveBeenCalledWith({ locale: 'ru' });
  });

  it('the page is in Russian but the profile still says Uzbek: pressing Русский saves it, no navigation', async () => {
    mocks.pathname = '/ru/store/profile';
    vi.mocked(updateMe).mockResolvedValue({ ...ME, locale: 'ru' });
    mount(<LanguagePicker variant="web" />, { locale: 'ru' });
    expect(screen.getByRole('radio', { name: 'Русский' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    await waitFor(() => expect(updateMe).toHaveBeenCalledWith({ locale: 'ru' }));
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  it('the profile already says Russian, the page is Uzbek: only the page changes, nothing is saved', async () => {
    mount(<LanguagePicker variant="web" />, { me: { ...ME, locale: 'ru' } });
    await userEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/ru/store/profile'));
    expect(updateMe).not.toHaveBeenCalled();
  });

  it('a second press while the new page is loading does nothing', async () => {
    vi.mocked(updateMe).mockResolvedValue({ ...ME, locale: 'ru' });
    mount(<LanguagePicker variant="web" />);
    const ru = screen.getByRole('radio', { name: 'Русский' });
    await userEvent.click(ru);
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledTimes(1));
    await userEvent.click(ru);
    await userEvent.click(screen.getByRole('radio', { name: 'O‘zbekcha' }));
    expect(updateMe).toHaveBeenCalledTimes(1);
    expect(hardNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('one lock for every switch on the page', () => {
  beforeEach(() => {
    mocks.pathname = '/store/profile';
  });

  it('a press on the header switch and one on the profile picker in the same tick save and navigate once', async () => {
    let finish: (me: Me) => void = () => undefined;
    vi.mocked(updateMe).mockReturnValue(new Promise<Me>((resolve) => (finish = resolve)));
    mount(
      <>
        <LanguageSwitch />
        <LanguagePicker variant="web" />
      </>,
    );
    const [switchRu, pickerRu] = screen.getAllByRole('radio', { name: 'Русский' });
    // fireEvent: both presses are handled before React renders in between, like two fast taps.
    act(() => {
      switchRu?.click();
      pickerRu?.click();
    });
    // The save starts on a microtask: let both presses settle before counting.
    await act(() => Promise.resolve());
    expect(updateMe).toHaveBeenCalledTimes(1);
    await act(() => {
      finish({ ...ME, locale: 'ru' });
      return Promise.resolve();
    });
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledTimes(1));
    // The page is loading: neither switch takes another choice.
    act(() => {
      switchRu?.click();
      pickerRu?.click();
    });
    expect(updateMe).toHaveBeenCalledTimes(1);
    expect(hardNavigate).toHaveBeenCalledTimes(1);
  });

  it('every switch shows the busy state while one of them saves', async () => {
    let finish: (me: Me) => void = () => undefined;
    vi.mocked(updateMe).mockReturnValue(new Promise<Me>((resolve) => (finish = resolve)));
    const view = mount(
      <>
        <LanguageSwitch />
        <LanguagePicker variant="web" />
      </>,
    );
    const busyOf = () => view.container.querySelector('span[aria-busy]');
    expect(busyOf()).toHaveAttribute('aria-busy', 'false');
    await userEvent.click(screen.getAllByRole('radio', { name: 'Русский' })[1] as HTMLElement);
    expect(busyOf()).toHaveAttribute('aria-busy', 'true');
    expect(busyOf()?.className).toContain('opacity-60');
    await act(() => {
      finish({ ...ME, locale: 'ru' });
      return Promise.resolve();
    });
  });
});

describe('store header switch', () => {
  beforeEach(() => {
    mocks.pathname = '/store';
  });
  const ru = () => screen.getByRole('radio', { name: 'Русский' });

  it('signed in: saves with PATCH /me first, then loads the page in the new language', async () => {
    vi.mocked(updateMe).mockResolvedValue({ ...ME, locale: 'ru' });
    mount(<LanguageSwitch />);
    await userEvent.click(ru());
    expect(updateMe).toHaveBeenCalledWith({ locale: 'ru' });
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/ru/store'));
  });

  it('signed in, refused: the language stays, a message appears and there is no navigation', async () => {
    vi.mocked(updateMe).mockRejectedValue(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }));
    mount(<LanguageSwitch />);
    await userEvent.click(ru());
    expect(await screen.findByRole('alert')).toHaveTextContent('Tilni o‘zgartirib bo‘lmadi');
    expect(hardNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'O‘zbekcha' })).toBeChecked();
  });

  it('a guest (no profile in the cache): only the page language changes, nothing is saved', async () => {
    mount(<LanguageSwitch />, { me: null });
    await userEvent.click(ru());
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/ru/store'));
    expect(updateMe).not.toHaveBeenCalled();
  });
});
