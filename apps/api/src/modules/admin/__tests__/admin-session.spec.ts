import { createHash } from 'node:crypto';
import type { AdminUser } from '@repo/db';
import { ADMIN_SESSION_IDLE_SEC, ADMIN_SESSION_TTL_SEC, AdminMeResponseSchema } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { isAllowlisted, maskTelegramId, mayUsePanel } from '../admins/admin-allowlist';
import { adminCookieSpec, clearAdminCookie, setAdminCookie } from '../auth/admin-cookies';
import { toAdminMe, toAdminSelf } from '../auth/admin-me.mapper';
import { hashAdminToken, isSessionLive, newAdminToken } from '../auth/admin-session.service';

const NOW = new Date('2026-11-16T10:00:00.000Z');
const at = (sec: number) => new Date(NOW.getTime() + sec * 1000);
const ADMIN: AdminUser = {
  id: 'cmadmin00000000000000001',
  telegramId: 1234567890n,
  name: 'Aziz',
  role: 'OPERATOR',
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('admin session token', () => {
  it('is 256 random bits as 43 base64url characters, stored as its sha256 hex', () => {
    const token = newAdminToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newAdminToken()).not.toBe(token);
    expect(hashAdminToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashAdminToken(token)).not.toContain(token);
  });
});

describe('isSessionLive (8 h absolute, 1 h idle)', () => {
  const row = { revokedAt: null, expiresAt: at(ADMIN_SESSION_TTL_SEC), lastUsedAt: NOW };

  it('live right after login and just before the idle limit', () => {
    expect(isSessionLive(row, NOW)).toBe(true);
    expect(isSessionLive(row, at(ADMIN_SESSION_IDLE_SEC - 1))).toBe(true);
  });

  it('dead at the idle limit, after a revoke and at the absolute end', () => {
    expect(isSessionLive(row, at(ADMIN_SESSION_IDLE_SEC))).toBe(false);
    expect(isSessionLive({ ...row, revokedAt: NOW }, NOW)).toBe(false);
    const used = { ...row, lastUsedAt: at(ADMIN_SESSION_TTL_SEC - 10) };
    expect(isSessionLive(used, at(ADMIN_SESSION_TTL_SEC - 5))).toBe(true);
    expect(isSessionLive(used, at(ADMIN_SESSION_TTL_SEC))).toBe(false);
  });
});

describe('allowlist and masking', () => {
  const config = { ADMIN_TELEGRAM_IDS: [1234567890n] as const };

  it('needs both keys: an active row AND an allowlisted id', () => {
    expect(isAllowlisted(config, 1234567890n)).toBe(true);
    expect(isAllowlisted(config, 1234567891n)).toBe(false);
    expect(mayUsePanel(config, ADMIN)).toBe(true);
    expect(mayUsePanel(config, { ...ADMIN, isActive: false })).toBe(false);
    expect(mayUsePanel(config, { ...ADMIN, telegramId: 99n })).toBe(false);
    expect(mayUsePanel(config, null)).toBe(false);
  });

  it('masks the Telegram id like docs/04 (12******90)', () => {
    expect(maskTelegramId(1234567890n)).toBe('12******90');
    expect(maskTelegramId(12345n)).toBe('12*45');
    expect(maskTelegramId(1234n)).toBe('****');
  });
});

describe('GET /admin/auth/me shape', () => {
  it('passes the shared schema, with the role permissions and limits as strings', () => {
    const config = buildTestEnv();
    const me = toAdminMe(
      {
        sessionId: 's1',
        admin: ADMIN,
        expiresAt: at(ADMIN_SESSION_TTL_SEC),
        idleExpiresAt: at(60),
      },
      config,
    );
    expect(AdminMeResponseSchema.parse(me)).toEqual(me);
    expect(me.admin).toEqual(toAdminSelf(ADMIN));
    expect(me.admin.telegramIdMasked).toBe('12******90');
    expect(me.permissions).toContain('orders.cancel');
    expect(me.permissions).not.toContain('admins.read');
    expect(me.limits.confirmThresholdTiyin).toBe(config.ADMIN_CONFIRM_THRESHOLD_TIYIN.toString());
    expect(me.session.idleExpiresAt).toBe(at(60).toISOString());
  });
});

describe('admin session cookie', () => {
  it('production: __Host- name, Secure, Path=/, a whole session long', () => {
    expect(adminCookieSpec('t', 'production')).toEqual({
      name: '__Host-adm_session',
      value: 't',
      path: '/',
      maxAge: ADMIN_SESSION_TTL_SEC,
      secure: true,
    });
  });

  it('development and test keep the plain name; only development drops Secure', () => {
    expect(adminCookieSpec('t', 'development')).toMatchObject({
      name: 'adm_session',
      secure: false,
    });
    expect(adminCookieSpec('t', 'test')).toMatchObject({ name: 'adm_session', secure: true });
  });

  it('is HttpOnly + SameSite=Strict when set, and cleared with the same name and path', () => {
    const calls: unknown[][] = [];
    const reply = { setCookie: (...args: unknown[]) => calls.push(args) };
    setAdminCookie(reply, 'tok', 'production');
    clearAdminCookie(reply, 'production');
    expect(calls).toEqual([
      [
        '__Host-adm_session',
        'tok',
        {
          path: '/',
          maxAge: ADMIN_SESSION_TTL_SEC,
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
        },
      ],
      [
        '__Host-adm_session',
        '',
        {
          path: '/',
          maxAge: 0,
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          expires: new Date(0),
        },
      ],
    ]);
  });
});
