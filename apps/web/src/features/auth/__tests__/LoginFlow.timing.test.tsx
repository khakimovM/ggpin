import { OTP_CODE_TTL_SEC } from '@repo/shared';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoginStatus, startLogin, verifyLogin } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/errors';
import { LoginFlow } from '../LoginFlow';
import { POLL_INTERVAL_MS, POLL_MAX_MS } from '../login-machine';
import { renderApp } from './test-utils';

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

vi.mock('../../../lib/api/auth', () => ({
  startLogin: vi.fn(),
  getLoginStatus: vi.fn(),
  verifyLogin: vi.fn(),
}));
vi.mock('../../../lib/navigation', () => ({ hardNavigate: vi.fn() }));

const NONCE = 'n'.repeat(43);
const BOT_URL = `https://t.me/ggpin_bot?start=login_${NONCE}`;

const mockStart = vi.mocked(startLogin);
const mockStatus = vi.mocked(getLoginStatus);

beforeEach(() => {
  vi.useFakeTimers();
  mockStart.mockResolvedValue({ nonce: NONCE, botUrl: BOT_URL });
  mockStatus.mockResolvedValue({ status: 'PENDING' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function startAndWait() {
  const view = renderApp(<LoginFlow next={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Telegram orqali kirish' }));
  await advance(0);
  return view;
}

describe('status polling', () => {
  it('asks every 2 seconds while the user has not opened the bot', async () => {
    await startAndWait();
    const first = mockStatus.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    await advance(POLL_INTERVAL_MS * 3);
    expect(mockStatus.mock.calls.length).toBe(first + 3);
    expect(mockStatus).toHaveBeenCalledWith(NONCE, expect.any(AbortSignal));
  });

  it('stops for good once the code was sent', async () => {
    await startAndWait();
    mockStatus.mockResolvedValue({ status: 'CODE_SENT' });
    await advance(POLL_INTERVAL_MS);
    expect(screen.getByRole('group')).toBeInTheDocument();
    const calls = mockStatus.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 10);
    expect(mockStatus.mock.calls.length).toBe(calls);
  });

  it.each(['DENIED', 'EXPIRED'] as const)('stops once the answer is %s', async (status) => {
    await startAndWait();
    mockStatus.mockResolvedValue({ status });
    await advance(POLL_INTERVAL_MS);
    const calls = mockStatus.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 10);
    expect(mockStatus.mock.calls.length).toBe(calls);
  });

  it('stops when the user cancels', async () => {
    await startAndWait();
    fireEvent.click(screen.getByRole('button', { name: 'Bekor qilish' }));
    await advance(0);
    const calls = mockStatus.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 5);
    expect(mockStatus.mock.calls.length).toBe(calls);
  });

  it('gives up after 10 minutes of PENDING and offers a new code', async () => {
    await startAndWait();
    await advance(POLL_MAX_MS - 1000);
    expect(screen.queryByRole('button', { name: 'Yangi kod olish' })).not.toBeInTheDocument();
    await advance(2000);
    expect(screen.getByRole('button', { name: 'Yangi kod olish' })).toBeInTheDocument();
    const calls = mockStatus.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 10);
    expect(mockStatus.mock.calls.length).toBe(calls);
  });

  it('a 429 on the status poll postpones the next poll until Retry-After', async () => {
    mockStatus.mockRejectedValueOnce(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 10 }),
    );
    await startAndWait();
    const first = mockStatus.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 3); // 6 s: still inside the wait
    expect(mockStatus.mock.calls.length).toBe(first);
    await advance(5_000); // past 10 s
    expect(mockStatus.mock.calls.length).toBe(first + 1);
    await advance(POLL_INTERVAL_MS); // the answer was fine: back to every 2 s
    expect(mockStatus.mock.calls.length).toBe(first + 2);
  });

  it('keeps polling through a failed poll (a dropped connection)', async () => {
    await startAndWait();
    mockStatus.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    await advance(POLL_INTERVAL_MS * 3);
    expect(screen.getByRole('status')).toHaveTextContent('Telegramʼdan javob kutilmoqda…');
    mockStatus.mockResolvedValue({ status: 'CODE_SENT' });
    await advance(POLL_INTERVAL_MS + 50);
    expect(screen.getByRole('group')).toBeInTheDocument();
  });
});

describe('countdowns', () => {
  async function toCodeStep() {
    mockStatus.mockResolvedValue({ status: 'CODE_SENT' });
    await startAndWait();
    await advance(1000);
  }

  it('the code timer counts down from 3:00 and expires the step at zero', async () => {
    await toCodeStep();
    expect(screen.getByText(/Kod \d:\d\d amal qiladi/)).toBeInTheDocument();
    expect(OTP_CODE_TTL_SEC).toBe(180);
    await advance(60_000);
    expect(screen.getByText(/Kod [12]:\d\d amal qiladi/)).toBeInTheDocument();
    await advance(121_000);
    expect(screen.getByText('Kod muddati tugadi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yangi kod olish' })).toBeInTheDocument();
  });

  it('a rate limit disables the start button and shows the Retry-After countdown', async () => {
    mockStart.mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 }),
    );
    renderApp(<LoginFlow next={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Telegram orqali kirish' }));
    await advance(1000);
    expect(screen.getByRole('alert')).toHaveTextContent('Urinishlar juda ko‘p');
    expect(screen.getByRole('alert')).toHaveTextContent(/0:(29|28)/);
    expect(screen.getByRole('button', { name: 'Telegram orqali kirish' })).toBeDisabled();

    await advance(30_000);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Telegram orqali kirish' })).toBeEnabled();
  });

  it('a rate limit while verifying keeps the code and re-enables the button afterwards', async () => {
    vi.mocked(verifyLogin).mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 20 }),
    );
    await toCodeStep();
    fireEvent.paste(screen.getByRole('group'), { clipboardData: { getData: () => '123456' } });
    await advance(100);
    expect(screen.getByRole('alert')).toHaveTextContent('Urinishlar juda ko‘p');
    expect(screen.getByRole('button', { name: 'Tasdiqlash' })).toBeDisabled();
    await advance(21_000);
    expect(screen.getByRole('button', { name: 'Tasdiqlash' })).toBeEnabled();
  });

  it('editing the digits cannot get around Retry-After', async () => {
    vi.mocked(verifyLogin).mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 20 }),
    );
    await toCodeStep();
    fireEvent.paste(screen.getByRole('group'), { clipboardData: { getData: () => '123456' } });
    await advance(100);
    expect(verifyLogin).toHaveBeenCalledTimes(1);

    // The last digit is replaced: the code is complete again, which normally submits at once.
    const boxes = screen.getAllByRole('textbox');
    fireEvent.change(boxes[5] as HTMLElement, { target: { value: '' } });
    fireEvent.change(boxes[5] as HTMLElement, { target: { value: '7' } });
    await advance(100);
    expect(verifyLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Urinishlar juda ko‘p');
    expect(screen.getByRole('button', { name: 'Tasdiqlash' })).toBeDisabled();

    // After the wait the edited code goes through.
    vi.mocked(verifyLogin).mockResolvedValue({ user: ME });
    await advance(21_000);
    fireEvent.click(screen.getByRole('button', { name: 'Tasdiqlash' }));
    await advance(100);
    expect(verifyLogin).toHaveBeenCalledTimes(2);
    expect(vi.mocked(verifyLogin).mock.calls[1]?.[0]).toMatchObject({ code: '123457' });
  });
});
