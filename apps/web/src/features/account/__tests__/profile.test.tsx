import type { Me, WalletResponse } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSessions } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/errors';
import { getMe, getWallet, updateMe } from '../../../lib/api/me';
import { hardNavigate } from '../../../lib/navigation';
import { useTgUiStore } from '../../../stores/tg-ui-store';
import { renderApp } from '../../auth/__tests__/test-utils';
import { TgProfile } from '../TgProfile';
import { WebProfile } from '../WebProfile';

const mocks = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_BOT_USERNAME: 'ggpin_test_bot',
    NEXT_PUBLIC_API_MOCKS: [] as string[],
    NEXT_PUBLIC_SUPPORT_URL: '',
  },
  pathname: '/tg/profile',
}));
vi.mock('../../../env', () => ({ env: mocks.env }));
vi.mock('../../../lib/api/me', () => ({ getMe: vi.fn(), getWallet: vi.fn(), updateMe: vi.fn() }));
vi.mock('../../../lib/api/auth', () => ({ listSessions: vi.fn(), logout: vi.fn() }));
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
const WALLET: WalletResponse = { balanceTiyin: '8540000', coins: '120', currency: 'UZS' };

function mount(ui: ReactElement, locale: 'uz' | 'ru' = 'uz') {
  return renderApp(<ThemeProvider variant="web">{ui}</ThemeProvider>, { locale });
}

// The first render of a big tree is the slow one (cold code, a loaded machine): it is paid once,
// here, with a timeout of its own, instead of making the first test of the file hit its 5 s limit.
beforeAll(async () => {
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(getWallet).mockResolvedValue(WALLET);
  vi.mocked(listSessions).mockResolvedValue([]);
  const view = mount(<WebProfile />);
  await screen.findByText('@sardor_r', {}, { timeout: 25_000 });
  view.unmount();
}, 30_000);

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(getWallet).mockResolvedValue(WALLET);
  vi.mocked(listSessions).mockResolvedValue([]);
  vi.mocked(updateMe).mockReset();
  vi.mocked(hardNavigate).mockReset();
  mocks.pathname = '/tg/profile';
  mocks.env.NEXT_PUBLIC_SUPPORT_URL = '';
  useTgUiStore.setState({ locale: 'uz' });
  window.localStorage.clear();
  delete document.documentElement.dataset.reduced;
});
afterEach(() => vi.clearAllMocks());

describe('TgProfile (Mini App)', () => {
  it('shows the identity, the server balance and the coins, with no phone line (Q6)', async () => {
    mount(<TgProfile />);
    expect(await screen.findByText('@sardor_r')).toBeInTheDocument();
    expect(screen.getByText('Sardor')).toBeInTheDocument();
    expect(await screen.findByText(/85.400/)).toHaveTextContent(/85.400/);
    expect(screen.getByRole('img', { name: 'Keshbek: 120 tanga' })).toBeInTheDocument();
    expect(screen.queryByText('Telefon raqami')).toBeNull();
    expect(screen.queryByText('Ulanmagan')).toBeNull();
  });

  it('the coins are written with the digit grouping of the language, exactly (no Number)', async () => {
    vi.mocked(getWallet).mockResolvedValue({ ...WALLET, coins: '9007199254740993' });
    mount(<TgProfile />);
    expect(await screen.findByText(/9.007.199.254.740.993/)).toBeInTheDocument();
  });

  it('services: invite and help are links; discount codes and the bonus code say "Tez orada"', async () => {
    mount(<TgProfile />);
    const services = (await screen.findByRole('heading', { name: 'Xizmatlar' })).closest('section');
    expect(services).not.toBeNull();
    const list = within(services as HTMLElement);
    expect(list.getByRole('link', { name: /Do‘stlarni taklif qilish/ })).toHaveAttribute(
      'href',
      '/tg/referral',
    );
    expect(list.getByRole('link', { name: /Yordam va savollar/ })).toHaveAttribute(
      'href',
      '/tg/help',
    );
    expect(list.getAllByText('Tez orada')).toHaveLength(2);
    expect(list.queryByRole('link', { name: /Chegirma kodlari/ })).toBeNull();
  });

  it('copies the Telegram ID and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(<TgProfile />);
    await userEvent.click(await screen.findByRole('button', { name: /ID ni nusxalash/ }));
    expect(writeText).toHaveBeenCalledWith('1187712645');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ID nusxalandi'));
  });

  it('a wallet that cannot be read shows its error and a retry, the rest stays', async () => {
    vi.mocked(getWallet).mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    mount(<TgProfile />);
    expect(await screen.findByText('Balansni yuklab bo‘lmadi')).toBeInTheDocument();
    expect(screen.getByText('@sardor_r')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByText(/85.400/)).toBeInTheDocument();
  });
});

describe('reduced motion switch', () => {
  it('turns the profile flag on and off: data-reduced on <html>, kept as a UI setting only', async () => {
    mount(<TgProfile />);
    const toggle = await screen.findByRole('switch', { name: 'Animatsiyalarni kamaytirish' });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(document.documentElement.dataset.reduced).toBe('true'));
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem('ggpin-reduced-motion')).toBe('true');
    await userEvent.click(toggle);
    await waitFor(() => expect(document.documentElement.dataset.reduced).toBeUndefined());
    expect(window.localStorage.getItem('ggpin-reduced-motion')).toBe('false');
  });
});

describe('WebProfile', () => {
  it('has the phone state, the sessions and the sign-out button; the phone is not editable', async () => {
    mount(<WebProfile />);
    expect(await screen.findByText('Telefon raqami')).toBeInTheDocument();
    expect(screen.getByText('Ulanmagan')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Faol sessiyalar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chiqish' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Telefon raqamini/ })).toBeNull();
  });

  it('shows "Ulangan" for a linked phone', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...ME, phoneLinked: true });
    mount(<WebProfile />);
    expect(await screen.findByText('Ulangan')).toBeInTheDocument();
  });

  it('the theme picker has three choices', async () => {
    mount(<WebProfile />);
    const group = await screen.findByRole('radiogroup', { name: 'Mavzu' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Avto', 'Yorug‘', 'Qorong‘i']);
  });

  it('the invitation link is built from the bot username in env and the code of the user', async () => {
    mount(<WebProfile />);
    expect(
      await screen.findByText('t.me/ggpin_test_bot?startapp=ref_sardor77'),
    ).toBeInTheDocument();
  });
});
