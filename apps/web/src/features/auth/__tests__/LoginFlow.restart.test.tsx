import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoginStatus, startLogin, verifyLogin } from '../../../lib/api/auth';
import { subscribeAuthEvents, type AuthEvent } from '../../../lib/api/auth-broadcast';
import { hardNavigate } from '../../../lib/navigation';
import { LoginFlow } from '../LoginFlow';
import { renderApp } from './test-utils';

vi.mock('../../../lib/api/auth', () => ({
  startLogin: vi.fn(),
  getLoginStatus: vi.fn(),
  verifyLogin: vi.fn(),
}));
vi.mock('../../../lib/api/auth-broadcast', () => ({ subscribeAuthEvents: vi.fn() }));
vi.mock('../../../lib/navigation', () => ({ hardNavigate: vi.fn() }));

const NONCE = 'n'.repeat(43);
const SECOND_NONCE = 'm'.repeat(43);
const botUrl = (nonce: string, bot = 'ggpin_bot') => `https://t.me/${bot}?start=login_${nonce}`;

let remote: (type: AuthEvent) => void = () => undefined;

beforeEach(() => {
  vi.mocked(startLogin).mockResolvedValue({ nonce: NONCE, botUrl: botUrl(NONCE) });
  vi.mocked(getLoginStatus).mockResolvedValue({ status: 'PENDING' });
  vi.mocked(subscribeAuthEvents).mockImplementation((handler) => {
    remote = handler;
    return () => undefined;
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

const clickStart = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Telegram orqali kirish' }));

describe('"Yangi kod olish" in the code step', () => {
  it('begins the login again with a new nonce', async () => {
    vi.mocked(getLoginStatus).mockResolvedValue({ status: 'CODE_SENT' });
    renderApp(<LoginFlow next={null} />);
    clickStart();
    await screen.findByRole('group');

    vi.mocked(startLogin).mockResolvedValue({ nonce: SECOND_NONCE, botUrl: botUrl(SECOND_NONCE) });
    vi.mocked(getLoginStatus).mockResolvedValue({ status: 'PENDING' });
    fireEvent.click(screen.getByRole('button', { name: 'Yangi kod olish' }));

    const link = await screen.findByRole('link', { name: 'Telegramʼni ochish' });
    expect(link).toHaveAttribute('href', botUrl(SECOND_NONCE));
    expect(startLogin).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(vi.mocked(getLoginStatus).mock.calls.at(-1)?.[0]).toBe(SECOND_NONCE),
    );
    expect(verifyLogin).not.toHaveBeenCalled();
  });

  it('is disabled while a code is being verified', async () => {
    vi.mocked(getLoginStatus).mockResolvedValue({ status: 'CODE_SENT' });
    vi.mocked(verifyLogin).mockReturnValue(new Promise(() => undefined));
    renderApp(<LoginFlow next={null} />);
    clickStart();
    await screen.findByRole('group');
    fireEvent.paste(screen.getByRole('group'), { clipboardData: { getData: () => '123456' } });
    await waitFor(() => expect(verifyLogin).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Yangi kod olish' })).toBeDisabled();
  });
});

describe('the bot link must belong to our bot', () => {
  it('a start answer naming another bot is refused: no link, an error, the start button back', async () => {
    vi.mocked(startLogin).mockResolvedValue({ nonce: NONCE, botUrl: botUrl(NONCE, 'evil_bot') });
    renderApp(<LoginFlow next={null} />);
    clickStart();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Telegram orqali kirish vaqtincha ishlamayapti',
    );
    expect(screen.queryByRole('link', { name: 'Telegramʼni ochish' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Telegram orqali kirish' })).toBeEnabled();
    expect(getLoginStatus).not.toHaveBeenCalled();
  });

  it('the configured bot name is matched without regard to case', async () => {
    vi.mocked(startLogin).mockResolvedValue({ nonce: NONCE, botUrl: botUrl(NONCE, 'GGPIN_BOT') });
    renderApp(<LoginFlow next={null} />);
    clickStart();
    expect(await screen.findByRole('link', { name: 'Telegramʼni ochish' })).toBeInTheDocument();
  });
});

describe('signed in from another tab', () => {
  it('leaves the login page for where the sign-in was heading, whatever the step', async () => {
    vi.mocked(getLoginStatus).mockResolvedValue({ status: 'CODE_SENT' });
    renderApp(<LoginFlow next="/store/orders?page=2" />);
    expect(hardNavigate).not.toHaveBeenCalled();

    remote('signed-in'); // still on the first step
    expect(hardNavigate).toHaveBeenLastCalledWith('/store/orders?page=2');

    clickStart();
    await screen.findByRole('group'); // the code step
    remote('signed-in');
    expect(hardNavigate).toHaveBeenCalledTimes(2);
    expect(hardNavigate).toHaveBeenLastCalledWith('/store/orders?page=2');
  });

  it('only a sign-in moves the page, and an unsafe next still falls back to the store', () => {
    renderApp(<LoginFlow next="//evil.com" />);
    remote('signed-out');
    expect(hardNavigate).not.toHaveBeenCalled();
    remote('signed-in');
    expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('/store');
  });

  it('unsubscribes when the page goes away', () => {
    const unsubscribe = vi.fn();
    vi.mocked(subscribeAuthEvents).mockReturnValue(unsubscribe);
    renderApp(<LoginFlow next={null} />).unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
