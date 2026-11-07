import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoginStatus, startLogin, verifyLogin } from '../../../lib/api/auth';
import { hardNavigate } from '../../../lib/navigation';
import { LoginFlow } from '../LoginFlow';
import { renderApp } from './test-utils';

vi.mock('../../../lib/api/auth', () => ({
  startLogin: vi.fn(),
  getLoginStatus: vi.fn(),
  verifyLogin: vi.fn(),
}));
vi.mock('../../../lib/navigation', () => ({ hardNavigate: vi.fn() }));

const NONCE = 'n'.repeat(43);
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

beforeEach(() => {
  vi.mocked(startLogin).mockResolvedValue({
    nonce: NONCE,
    botUrl: `https://t.me/ggpin_bot?start=login_${NONCE}`,
  });
  vi.mocked(getLoginStatus).mockResolvedValue({ status: 'CODE_SENT' });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const pasteCode = (code: string) =>
  fireEvent.paste(screen.getByRole('group'), { clipboardData: { getData: () => code } });

describe('LoginFlow: where a sign-in leads (open redirect)', () => {
  async function landing(next: string | null): Promise<string | undefined> {
    vi.mocked(verifyLogin).mockResolvedValue({ user: USER });
    const view = renderApp(<LoginFlow next={next} />);
    fireEvent.click(screen.getByRole('button', { name: 'Telegram orqali kirish' }));
    await screen.findByRole('group');
    pasteCode(CODE);
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledTimes(1));
    view.unmount();
    return vi.mocked(hardNavigate).mock.calls[0]?.[0];
  }

  it.each(['/store/orders?page=2', '/ru/store/profile', '/store'])(
    'follows the same-origin path %s',
    async (next) => {
      expect(await landing(next)).toBe(next);
    },
  );

  it.each([
    '//evil.com',
    '/\\evil.com',
    'https://evil.com',
    'javascript:alert(1)',
    '/%2F%2Fevil.com',
    '/\tevil.com',
    '/\n/evil.com',
    '/.//evil.com',
    '/login',
    '/ru/login?next=/store',
    '',
  ])('refuses %j and lands on the store', async (next) => {
    expect(await landing(next)).toBe('/store');
  });

  it('no next at all lands on the store', async () => {
    expect(await landing(null)).toBe('/store');
  });
});
