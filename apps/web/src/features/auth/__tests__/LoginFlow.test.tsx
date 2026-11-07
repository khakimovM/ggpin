import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoginStatus, startLogin, verifyLogin } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/errors';
import { hardNavigate } from '../../../lib/navigation';
import { LoginFlow } from '../LoginFlow';
import { renderApp, type TestLocale } from './test-utils';

vi.mock('../../../lib/api/auth', () => ({
  startLogin: vi.fn(),
  getLoginStatus: vi.fn(),
  verifyLogin: vi.fn(),
}));
vi.mock('../../../lib/navigation', () => ({ hardNavigate: vi.fn() }));

const NONCE = 'n'.repeat(43);
const BOT_URL = `https://t.me/ggpin_bot?start=login_${NONCE}`;
// A fixed, obviously fake code: it must never reach a log line or a URL.
const CODE = '123456';
const USER = {
  id: 'user_1',
  telegramId: '123456789',
  username: 'sardor_r',
  firstName: 'Sardor',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'REF123',
  phoneLinked: false,
} as const;

const mockStart = vi.mocked(startLogin);
const mockStatus = vi.mocked(getLoginStatus);
const mockVerify = vi.mocked(verifyLogin);

beforeEach(() => {
  mockStart.mockResolvedValue({ nonce: NONCE, botUrl: BOT_URL });
  mockStatus.mockResolvedValue({ status: 'PENDING' });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const clickStart = (label = 'Telegram orqali kirish') =>
  fireEvent.click(screen.getByRole('button', { name: label }));

const pasteCode = (code: string) =>
  fireEvent.paste(screen.getByRole('group'), { clipboardData: { getData: () => code } });

async function reachCodeStep(locale: TestLocale = 'uz', next: string | null = null) {
  mockStatus.mockResolvedValue({ status: 'CODE_SENT' });
  const view = renderApp(<LoginFlow next={next} />, { locale });
  clickStart(locale === 'uz' ? 'Telegram orqali kirish' : 'Войти через Telegram');
  await screen.findByRole('group');
  return view;
}

const invalid = (attemptsLeft: number) =>
  new ApiError({ status: 422, code: 'CODE_INVALID', details: { attemptsLeft } });

describe('LoginFlow: start and waiting', () => {
  it('shows the start button, then the 3 steps with the bot link taken from botUrl', async () => {
    renderApp(<LoginFlow next={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ggpinʼga kirish');
    clickStart();
    const link = await screen.findByRole('link', { name: 'Telegramʼni ochish' });
    expect(link).toHaveAttribute('href', BOT_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('status')).toHaveTextContent('Telegramʼdan javob kutilmoqda…');
  });

  it('a second click while the request is out starts one login', async () => {
    mockStart.mockReturnValue(new Promise(() => undefined));
    renderApp(<LoginFlow next={null} />);
    const button = screen.getByRole('button', { name: 'Telegram orqali kirish' });
    fireEvent.click(button);
    const busy = await screen.findByRole('button', { name: 'Telegram ochilmoqda…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('cancel goes back to the start without another request', async () => {
    renderApp(<LoginFlow next={null} />);
    clickStart();
    fireEvent.click(await screen.findByRole('button', { name: 'Bekor qilish' }));
    expect(screen.getByRole('button', { name: 'Telegram orqali kirish' })).toBeInTheDocument();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('Russian: the same flow with Russian text', async () => {
    renderApp(<LoginFlow next={null} />, { locale: 'ru' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Вход в ggpin');
    clickStart('Войти через Telegram');
    expect(await screen.findByRole('link', { name: 'Открыть Telegram' })).toHaveAttribute(
      'href',
      BOT_URL,
    );
  });
});

describe('LoginFlow: the bot answers', () => {
  it('DENIED shows the rejection and the restart button asks for a new nonce', async () => {
    mockStatus.mockResolvedValue({ status: 'DENIED' });
    renderApp(<LoginFlow next={null} />);
    clickStart();
    expect(await screen.findByRole('alert')).toHaveTextContent('So‘rov Telegramʼda rad etildi.');
    fireEvent.click(screen.getByRole('button', { name: 'Qaytadan boshlash' }));
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(2));
  });

  it('EXPIRED and an unknown nonce (404) both end up on the new-code screen', async () => {
    mockStatus.mockResolvedValue({ status: 'EXPIRED' });
    const first = renderApp(<LoginFlow next={null} />);
    clickStart();
    expect(await screen.findByText('Kod muddati tugadi')).toBeInTheDocument();
    first.unmount();

    mockStatus.mockRejectedValue(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    renderApp(<LoginFlow next={null} />);
    clickStart();
    expect(await screen.findByText('Kod muddati tugadi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yangi kod olish' })).toBeInTheDocument();
  });
});

describe('LoginFlow: the code', () => {
  it('a full code is verified with the nonce and leads to the store, by full navigation', async () => {
    mockVerify.mockResolvedValue({ user: USER });
    await reachCodeStep();
    expect(screen.getByText('Kod Telegramʼga yuborildi')).toBeInTheDocument();
    pasteCode(CODE);
    await waitFor(() => expect(mockVerify).toHaveBeenCalledTimes(1));
    expect(mockVerify).toHaveBeenCalledWith({ nonce: NONCE, code: CODE });
    expect(await screen.findByText('Xush kelibsiz, Sardor!')).toBeInTheDocument();
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/store'));
  });

  it('Russian lands on /ru/store', async () => {
    mockVerify.mockResolvedValue({ user: USER });
    await reachCodeStep('ru');
    pasteCode(CODE);
    expect(await screen.findByText('Добро пожаловать, Sardor!')).toBeInTheDocument();
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/ru/store'));
  });

  it('a user without a name is welcomed without one', async () => {
    mockVerify.mockResolvedValue({ user: { ...USER, firstName: null, username: null } });
    await reachCodeStep();
    pasteCode(CODE);
    expect(await screen.findByText('Xush kelibsiz!')).toBeInTheDocument();
  });

  it('the Tasdiqlash button stays disabled until all 6 digits are there', async () => {
    mockVerify.mockResolvedValue({ user: USER });
    await reachCodeStep();
    const button = screen.getByRole('button', { name: 'Tasdiqlash' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getAllByRole('textbox')[0] as HTMLElement, { target: { value: '1' } });
    expect(button).toBeDisabled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('never writes the code to the console, the URL or the history', async () => {
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    mockVerify.mockRejectedValue(invalid(4));
    const before = window.location.href;
    await reachCodeStep();
    pasteCode(CODE);
    await screen.findByText(/Kod noto‘g‘ri/);
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(CODE);
    }
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toContain(CODE);
  });
});

describe('LoginFlow: wrong codes', () => {
  it('uz: shows the tries left, and editing a digit clears the message and verifies again', async () => {
    mockVerify.mockRejectedValueOnce(invalid(3)).mockResolvedValueOnce({ user: USER });
    await reachCodeStep();
    pasteCode(CODE);
    expect(await screen.findByText('Kod noto‘g‘ri. Yana 3 ta urinish qoldi')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')[0]).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getAllByRole('textbox')[5] as HTMLElement, { target: { value: '' } });
    expect(screen.queryByText(/Yana 3 ta urinish/)).not.toBeInTheDocument();
    fireEvent.change(screen.getAllByRole('textbox')[5] as HTMLElement, { target: { value: '7' } });
    await waitFor(() => expect(mockVerify).toHaveBeenCalledTimes(2));
    expect(mockVerify).toHaveBeenLastCalledWith({ nonce: NONCE, code: '123457' });
  });

  it.each([
    [1, 'Код неверный. Осталась 1 попытка'],
    [2, 'Код неверный. Осталось 2 попытки'],
    [4, 'Код неверный. Осталось 4 попытки'],
    [5, 'Код неверный. Осталось 5 попыток'],
    [21, 'Код неверный. Осталась 21 попытка'],
  ])('ru: %s tries left uses the right plural form', async (count, text) => {
    mockVerify.mockRejectedValue(invalid(count));
    await reachCodeStep('ru');
    pasteCode(CODE);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('no tries left, CODE_EXPIRED and CODE_ALREADY_USED all ask for a new code', async () => {
    for (const rejection of [
      invalid(0),
      new ApiError({ status: 422, code: 'CODE_EXPIRED' }),
      new ApiError({ status: 422, code: 'CODE_ALREADY_USED' }),
    ]) {
      mockVerify.mockRejectedValueOnce(rejection);
      const view = await reachCodeStep();
      pasteCode(CODE);
      // The expired screen (the code step has its own "Yangi kod olish" button too).
      expect(await screen.findByText('Kod muddati tugadi')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Yangi kod olish' })).toBeInTheDocument();
      view.unmount();
    }
  });

  it('a CODE_INVALID without details is a generic failure, not a made-up number', async () => {
    mockVerify.mockRejectedValue(new ApiError({ status: 422, code: 'CODE_INVALID' }));
    await reachCodeStep();
    pasteCode(CODE);
    expect(
      await screen.findByText('Kodni tekshirib bo‘lmadi. Qayta urinib ko‘ring.'),
    ).toBeInTheDocument();
  });
});

describe('LoginFlow: failures', () => {
  it('a network failure while verifying keeps the code and can be retried with the button', async () => {
    mockVerify
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }))
      .mockResolvedValueOnce({ user: USER });
    await reachCodeStep();
    pasteCode(CODE);
    expect(await screen.findByText(/Internet bilan aloqa yo‘q/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tasdiqlash' }));
    expect(await screen.findByText('Xush kelibsiz, Sardor!')).toBeInTheDocument();
    expect(mockVerify).toHaveBeenCalledTimes(2);
  });

  it('USER_BLOCKED at the start shows the blocked message', async () => {
    mockStart.mockRejectedValue(new ApiError({ status: 403, code: 'USER_BLOCKED' }));
    renderApp(<LoginFlow next={null} />);
    clickStart();
    expect(await screen.findByRole('alert')).toHaveTextContent('Hisobingiz bloklangan');
  });

  it('a network error and a server error at the start each show their text', async () => {
    mockStart.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    renderApp(<LoginFlow next={null} />);
    clickStart();
    expect(await screen.findByRole('alert')).toHaveTextContent('Internet bilan aloqa yo‘q');

    mockStart.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }));
    clickStart();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Telegram orqali kirish vaqtincha ishlamayapti',
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Bir necha daqiqadan so‘ng');
  });
});
