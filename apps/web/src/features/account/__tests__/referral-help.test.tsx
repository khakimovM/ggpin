import type { Me } from '@repo/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { getMe } from '../../../lib/api/me';
import { TelegramContext } from '../../../telegram/telegram-context';
import { createFakeWebApp, installWebApp } from '../../../telegram/__tests__/fake-webapp';
import { renderApp } from '../../auth/__tests__/test-utils';
import { HelpView } from '../HelpView';
import { ReferralCard } from '../ReferralCard';
import { ReferralView } from '../ReferralView';

const mocks = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_BOT_USERNAME: 'ggpin_test_bot',
    NEXT_PUBLIC_API_MOCKS: [] as string[],
    NEXT_PUBLIC_SUPPORT_URL: '',
  },
}));
vi.mock('../../../env', () => ({ env: mocks.env }));
vi.mock('../../../lib/api/me', () => ({ getMe: vi.fn() }));

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

// The first render of a big tree is the slow one (cold code, a loaded machine): it is paid once,
// here, with a timeout of its own, instead of making the first test of the file hit its 5 s limit.
beforeAll(async () => {
  vi.mocked(getMe).mockResolvedValue(ME);
  const view = renderApp(<ReferralView />);
  await screen.findByText(/startapp=ref_/, {}, { timeout: 25_000 });
  view.unmount();
}, 30_000);

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(ME);
  mocks.env.NEXT_PUBLIC_SUPPORT_URL = '';
  mocks.env.NEXT_PUBLIC_BOT_USERNAME = 'ggpin_test_bot';
});
afterEach(() => {
  delete window.Telegram;
  vi.clearAllMocks();
});

describe('ReferralView', () => {
  it('the link comes from the bot username in env and the code of the user, and can be copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(<ReferralView />);
    expect(
      await screen.findByText('t.me/ggpin_test_bot?startapp=ref_sardor77'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nusxalash' }));
    expect(writeText).toHaveBeenCalledWith('https://t.me/ggpin_test_bot?startapp=ref_sardor77');
    await waitFor(() => expect(screen.getByText('Nusxalandi')).toBeInTheDocument());
  });

  it('another bot username in env gives another link: nothing is hardcoded', async () => {
    mocks.env.NEXT_PUBLIC_BOT_USERNAME = 'other_shop_bot';
    renderApp(<ReferralView />);
    expect(
      await screen.findByText('t.me/other_shop_bot?startapp=ref_sardor77'),
    ).toBeInTheDocument();
  });

  it('share opens Telegram’s own share dialog inside the Mini App', async () => {
    const app = createFakeWebApp();
    installWebApp(app);
    renderApp(
      <TelegramContext.Provider value={{ phase: 'telegram', webApp: app }}>
        <ReferralView />
      </TelegramContext.Provider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Ulashish' }));
    expect(app.openTelegramLink).toHaveBeenCalledTimes(1);
    const url = new URL(vi.mocked(app.openTelegramLink).mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://t.me/share/url');
    expect(url.searchParams.get('url')).toBe('https://t.me/ggpin_test_bot?startapp=ref_sardor77');
  });

  it('the statistics are an entry marked "Tez orada", with no made-up numbers (Q8)', async () => {
    renderApp(<ReferralView />);
    const stats = (await screen.findByRole('heading', { name: /Statistika/ })).closest('section');
    expect(within(stats as HTMLElement).getByText('Tez orada')).toBeInTheDocument();
  });

  it('error: when the profile cannot be read there is no link and a way to retry', async () => {
    vi.mocked(getMe).mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK' }));
    renderApp(<ReferralView />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nusxalash' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument();
  });
});

describe('HelpView', () => {
  it('opens the first question and shows one answer at a time', async () => {
    renderApp(<HelpView />);
    const first = screen.getByRole('button', { name: /Buyurtma qancha vaqtda yetkaziladi/ });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/odatda tez yetkaziladi/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Keshbek tangalari nima/ }));
    await waitFor(() => expect(first).toHaveAttribute('aria-expanded', 'false'));
    expect(await screen.findByText(/xaridlar uchun beriladigan bonus/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
  });

  it('the answer that names the brand takes it from the brand module', async () => {
    renderApp(<HelpView />);
    await userEvent.click(screen.getByRole('button', { name: /Balansdagi pulni qaytarib/ }));
    expect(await screen.findByText(/Balans faqat ggpinʼdagi xaridlar uchun/)).toBeInTheDocument();
  });

  it('without a support link the card says it is not available and draws no button', () => {
    renderApp(<HelpView />);
    expect(screen.getByText('Operator havolasi hozircha mavjud emas')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Operatorga yozish/ })).toBeNull();
    expect(screen.getByText('Har kuni 09:00–23:00')).toBeInTheDocument();
  });

  it('with a t.me support link: the button and the handle read from the link', () => {
    mocks.env.NEXT_PUBLIC_SUPPORT_URL = 'https://t.me/shop_support';
    renderApp(<HelpView />);
    expect(screen.getByRole('link', { name: /Operatorga yozish/ })).toHaveAttribute(
      'href',
      'https://t.me/shop_support',
    );
    expect(screen.getByText('Telegramʼda @shop_support bilan chat ochiladi')).toBeInTheDocument();
  });

  it('Russian: the card and a question are in Russian', () => {
    mocks.env.NEXT_PUBLIC_SUPPORT_URL = 'https://t.me/shop_support';
    renderApp(<HelpView />, { locale: 'ru' });
    expect(screen.getByRole('link', { name: /Написать оператору/ })).toBeInTheDocument();
    expect(screen.getByText('Ежедневно 09:00–23:00')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Как быстро доставляется заказ/ }),
    ).toBeInTheDocument();
  });
});

describe('the invitation link is missing', () => {
  it('Mini App: /me failing is an error with a retry, a code that makes no link is a plain message', async () => {
    vi.mocked(getMe).mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    const view = renderApp(<ReferralView />);
    expect(await screen.findByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument();
    view.unmount();

    vi.mocked(getMe).mockResolvedValue({ ...ME, referralCode: 'NOT VALID' });
    renderApp(<ReferralView />);
    expect(await screen.findByText(/Havola hozircha mavjud emas/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Qayta urinish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nusxalash' })).toBeNull();
  });

  it('web card: no skeleton forever, the same three states', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...ME, referralCode: 'NOT VALID' });
    const view = renderApp(<ReferralCard />);
    expect(await screen.findByText(/Havola hozircha mavjud emas/)).toBeInTheDocument();
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
    view.unmount();

    vi.mocked(getMe).mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK' }));
    renderApp(<ReferralCard />);
    expect(await screen.findByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument();
  });
});
