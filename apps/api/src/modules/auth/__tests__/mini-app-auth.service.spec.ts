import { Logger } from '@nestjs/common';
import type { User } from '@repo/db';
import { TEST_JWT_ACCESS_SECRET, TEST_TG_SESSION_SECRET } from '../../../config/__tests__/test-env';
import type { FixedWindowCounter, WindowHit } from '../../../infra/redis/fixed-window-counter';
import type { UsersService } from '../../users/users.service';
import type { InitDataVerifier } from '../init-data.verifier';
import { ACCOUNT_LIMIT_TIMEOUT_MS, MiniAppAuthService } from '../mini-app-auth.service';
import { TokenCodec } from '../token-codec';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function setup(hit: () => Promise<WindowHit>) {
  const user = {
    id: 'u1',
    telegramId: 77n,
    username: null,
    firstName: 'Ann',
    photoUrl: null,
    locale: 'uz',
    referralCode: 'abcd1234',
    phone: null,
    isBlocked: false,
  } as unknown as User;
  const verifier = {
    verify: () => ({ user: { id: 77n, firstName: 'Ann' }, startParam: undefined }),
  } as unknown as InitDataVerifier;
  const users = {
    ensureTelegramUser: () => Promise.resolve({ user, created: false }),
  } as unknown as UsersService;
  const codec = new TokenCodec({
    JWT_ACCESS_SECRET: TEST_JWT_ACCESS_SECRET,
    TG_SESSION_SECRET: TEST_TG_SESSION_SECRET,
  });
  const counter = { hit: jest.fn(hit) } as unknown as FixedWindowCounter;
  return new MiniAppAuthService(verifier, users, codec, counter, { now: () => NOW });
}

const spyOnWarn = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

describe('MiniAppAuthService account limiter', () => {
  let warn: ReturnType<typeof spyOnWarn>;
  beforeEach(() => {
    warn = spyOnWarn();
  });
  afterEach(() => warn.mockRestore());

  it('a rejecting limiter fails open: the login succeeds, one warning, error name only', async () => {
    const service = setup(() => Promise.reject(new TypeError('redis://:hunter2@host down')));
    await expect(service.login('init')).resolves.toMatchObject({ user: { id: 'u1' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe('account rate limit unavailable: TypeError');
  });

  it('a hanging limiter is cut off after the timeout: login succeeds, one warning', async () => {
    const service = setup(() => new Promise<WindowHit>(() => undefined));
    const started = Date.now();
    await expect(service.login('init')).resolves.toMatchObject({ user: { id: 'u1' } });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(ACCOUNT_LIMIT_TIMEOUT_MS - 20);
    expect(took).toBeLessThan(ACCOUNT_LIMIT_TIMEOUT_MS + 1500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe('account rate limit unavailable: LimiterTimeout');
  });

  it('over the limit: RATE_LIMITED carrying Retry-After with the remaining window', async () => {
    const service = setup(() => Promise.resolve({ count: 11, ttlSec: 42 }));
    await expect(service.login('init')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      headers: { 'Retry-After': '42' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('at the limit it still passes', async () => {
    const service = setup(() => Promise.resolve({ count: 10, ttlSec: 42 }));
    await expect(service.login('init')).resolves.toBeDefined();
  });
});
