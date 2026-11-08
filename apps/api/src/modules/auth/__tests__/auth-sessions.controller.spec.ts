import { Logger } from '@nestjs/common';
import type { AuthRequest } from '../../../common/auth/auth-user';
import type { CookieReply } from '../auth-cookies';
import { AuthSessionsController, MAX_LOGOUT_REFRESH_TOKENS } from '../auth-sessions.controller';
import type { WebSessionService } from '../web-session.service';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function setup() {
  const revokeByRefreshToken = jest.fn<Promise<void>, [string, Date]>().mockResolvedValue();
  const controller = new AuthSessionsController(
    { revokeByRefreshToken } as unknown as WebSessionService,
    { now: () => NOW },
    { NODE_ENV: 'test' },
  );
  const reply: CookieReply = { setCookie: () => undefined };
  const logout = (cookie: string) => {
    const request: AuthRequest = { method: 'POST', headers: { cookie } };
    return controller.logout(request, reply);
  };
  return { revokeByRefreshToken, logout };
}

const values = (n: number): string => Array.from({ length: n }, (_, i) => `v${String(i)}`).join();
const header = (list: string[]): string => list.map((v) => `refresh_token=${v}`).join('; ');

describe('AuthSessionsController.logout with repeated refresh cookies', () => {
  let warn: jest.SpyInstance<void, [unknown, ...unknown[]]>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('revokes at most 5 values and logs how many it dropped, never a value', async () => {
    const { logout, revokeByRefreshToken } = setup();
    const many = values(240).split(',');
    await expect(logout(header(many))).resolves.toEqual({});
    expect(revokeByRefreshToken).toHaveBeenCalledTimes(MAX_LOGOUT_REFRESH_TOKENS);
    expect(revokeByRefreshToken.mock.calls.map((c) => c[0])).toEqual(many.slice(0, 5));
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('security event=LOGOUT_COOKIE_VALUES_DROPPED dropped=235');
    expect(logged.join(' ')).not.toMatch(/v\d/);
  });

  it('revokes a repeated value once and skips empty values', async () => {
    const { logout, revokeByRefreshToken } = setup();
    await logout(header(['same', 'same', '', 'other', 'same']));
    expect(revokeByRefreshToken.mock.calls.map((c) => c[0])).toEqual(['same', 'other']);
    expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).not.toContain('DROPPED');
  });

  it('a single cookie is revoked as before', async () => {
    const { logout, revokeByRefreshToken } = setup();
    await logout(header(['only']));
    expect(revokeByRefreshToken).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
