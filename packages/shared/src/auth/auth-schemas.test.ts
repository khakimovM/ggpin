import { describe, expect, it } from 'vitest';
import {
  INIT_DATA_MAX_LENGTH,
  loginStartBodySchema,
  loginStartResponseSchema,
  loginStatusParamsSchema,
  loginStatusResponseSchema,
  loginVerifyBodySchema,
  logoutResponseSchema,
  meSchema,
  sessionItemSchema,
  sessionUserResponseSchema,
  sessionsResponseSchema,
  updateMeBodySchema,
  webAppLoginBodySchema,
  webAppLoginResponseSchema,
} from './auth-schemas';

const NONCE = ['A', 'b', '0', '_', '-'].join('').repeat(9).slice(0, 43);
const ME = {
  id: 'cm0user',
  telegramId: '123456789',
  username: null,
  firstName: 'Ali',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'ab12cd34',
  phoneLinked: false,
};
const SESSION = {
  id: 'fam1',
  userAgent: null,
  ipMasked: '203.0.113.x',
  createdAt: '2026-11-02T10:00:00.000Z',
  lastUsedAt: '2026-11-02T10:05:00.000Z',
  current: true,
};

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown): boolean =>
  schema.safeParse(v).success;

describe('/me', () => {
  it('parses the contract shape and rejects drift', () => {
    expect(ok(meSchema, ME)).toBe(true);
    expect(ok(meSchema, { ...ME, telegramId: 123 })).toBe(false);
    expect(ok(meSchema, { ...ME, locale: 'en' })).toBe(false);
    expect(ok(meSchema, { ...ME, phoneLinked: 'no' })).toBe(false);
    const { referralCode: _omit, ...rest } = ME;
    expect(ok(meSchema, rest)).toBe(false);
  });

  it('PATCH body is strict and limited to uz|ru', () => {
    expect(ok(updateMeBodySchema, { locale: 'ru' })).toBe(true);
    expect(ok(updateMeBodySchema, { locale: 'en' })).toBe(false);
    expect(ok(updateMeBodySchema, {})).toBe(false);
    expect(ok(updateMeBodySchema, { locale: 'uz', isBlocked: false })).toBe(false);
  });
});

describe('Mini App login', () => {
  it('bounds initData and is strict', () => {
    expect(ok(webAppLoginBodySchema, { initData: 'a=b' })).toBe(true);
    expect(ok(webAppLoginBodySchema, { initData: '' })).toBe(false);
    expect(ok(webAppLoginBodySchema, { initData: 'x'.repeat(INIT_DATA_MAX_LENGTH) })).toBe(true);
    expect(ok(webAppLoginBodySchema, { initData: 'x'.repeat(INIT_DATA_MAX_LENGTH + 1) })).toBe(
      false,
    );
    expect(ok(webAppLoginBodySchema, { initData: 'a=b', extra: 1 })).toBe(false);
  });

  it('response carries a numeric expiresIn and the /me user', () => {
    expect(ok(webAppLoginResponseSchema, { token: 't', expiresIn: 3600, user: ME })).toBe(true);
    expect(ok(webAppLoginResponseSchema, { token: 't', expiresIn: '3600', user: ME })).toBe(false);
    expect(ok(webAppLoginResponseSchema, { token: '', expiresIn: 3600, user: ME })).toBe(false);
    expect(ok(webAppLoginResponseSchema, { token: 't', expiresIn: 0, user: ME })).toBe(false);
  });
});

describe('web OTP login', () => {
  it('start: empty strict body, bot url response', () => {
    expect(ok(loginStartBodySchema, {})).toBe(true);
    expect(ok(loginStartBodySchema, { a: 1 })).toBe(false);
    const botUrl = `https://t.me/ggpin_bot?start=login_${NONCE}`;
    expect(ok(loginStartResponseSchema, { nonce: NONCE, botUrl })).toBe(true);
    expect(ok(loginStartResponseSchema, { nonce: NONCE, botUrl: 'https://evil.example/x' })).toBe(
      false,
    );
    expect(ok(loginStartResponseSchema, { nonce: 'short', botUrl })).toBe(false);
  });

  it('status: params and the four public statuses (never USED)', () => {
    expect(ok(loginStatusParamsSchema, { nonce: NONCE })).toBe(true);
    expect(ok(loginStatusParamsSchema, { nonce: 'x' })).toBe(false);
    for (const status of ['PENDING', 'CODE_SENT', 'DENIED', 'EXPIRED']) {
      expect(ok(loginStatusResponseSchema, { status })).toBe(true);
    }
    expect(ok(loginStatusResponseSchema, { status: 'USED' })).toBe(false);
  });

  it('verify: six-digit code only', () => {
    expect(ok(loginVerifyBodySchema, { nonce: NONCE, code: '012345' })).toBe(true);
    for (const code of ['12345', '1234567', 'abcdef', '12345 ', 123456]) {
      expect(ok(loginVerifyBodySchema, { nonce: NONCE, code })).toBe(false);
    }
    expect(ok(loginVerifyBodySchema, { nonce: NONCE, code: '123456', x: 1 })).toBe(false);
  });

  it('verify/refresh return { user }; logout returns {}', () => {
    expect(ok(sessionUserResponseSchema, { user: ME })).toBe(true);
    expect(ok(sessionUserResponseSchema, {})).toBe(false);
    expect(ok(logoutResponseSchema, {})).toBe(true);
    expect(ok(logoutResponseSchema, { ok: true })).toBe(false);
  });
});

describe('sessions', () => {
  it('item uses ISO dates and no raw ip', () => {
    expect(ok(sessionItemSchema, SESSION)).toBe(true);
    expect(ok(sessionItemSchema, { ...SESSION, createdAt: 'yesterday' })).toBe(false);
    expect(ok(sessionItemSchema, { ...SESSION, current: 'yes' })).toBe(false);
    expect(ok(sessionsResponseSchema, [SESSION, { ...SESSION, id: 'fam2', current: false }])).toBe(
      true,
    );
    expect(ok(sessionsResponseSchema, [])).toBe(true);
  });
});
