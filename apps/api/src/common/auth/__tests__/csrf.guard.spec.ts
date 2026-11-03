import { CSRF_HEADER } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { AppError } from '../../exceptions/app-error';
import type { AuthUser } from '../auth-user';
import { CsrfGuard } from '../csrf.guard';
import { SKIP_CSRF_KEY } from '../skip-csrf.decorator';
import { fakeContext, fakeRequest, type FakeRequestInit } from './guard-context';

const config = buildTestEnv({ MINI_APP_URL: 'https://app.ggpin.test/tg' });
const WEB_ORIGIN = 'http://localhost:3000';
const tgUser: AuthUser = { id: 'u1', telegramId: 1n, channel: 'tg' };
const webUser: AuthUser = { id: 'u1', telegramId: 1n, channel: 'web', sessionFamilyId: 'f' };

function check(init: FakeRequestInit, metadata: Record<string, unknown> = {}): boolean {
  const { context, reflector } = fakeContext(fakeRequest(init), metadata);
  return new CsrfGuard(reflector, config).canActivate(context);
}

function denial(init: FakeRequestInit, metadata: Record<string, unknown> = {}): string {
  try {
    check(init, metadata);
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

const good = { [CSRF_HEADER]: '1', origin: WEB_ORIGIN };

describe('CsrfGuard', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('never checks %s', (method) => {
    expect(check({ method })).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s with token + allowed Origin passes', (method) => {
    expect(check({ method, headers: good, authUser: webUser })).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s without anything -> NOT_FOUND', (method) => {
    expect(denial({ method, authUser: webUser })).toBe('NOT_FOUND');
  });

  it('missing X-CSRF-Token -> NOT_FOUND', () => {
    expect(denial({ method: 'POST', headers: { origin: WEB_ORIGIN } })).toBe('NOT_FOUND');
  });

  it('blank X-CSRF-Token -> NOT_FOUND', () => {
    expect(denial({ method: 'POST', headers: { [CSRF_HEADER]: '  ', origin: WEB_ORIGIN } })).toBe(
      'NOT_FOUND',
    );
  });

  it('missing Origin -> NOT_FOUND', () => {
    expect(denial({ method: 'POST', headers: { [CSRF_HEADER]: '1' } })).toBe('NOT_FOUND');
  });

  it.each([
    'https://evil.example',
    'null',
    `${WEB_ORIGIN}/`, // an Origin never has a path
    'http://localhost:3000.evil.example',
    'https://localhost:3000',
    'HTTP://LOCALHOST:3000',
  ])('foreign or malformed Origin %p -> NOT_FOUND', (origin) => {
    expect(denial({ method: 'POST', headers: { [CSRF_HEADER]: '1', origin } })).toBe('NOT_FOUND');
  });

  it('accepts every first-party origin (web, admin, Mini App)', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://app.ggpin.test',
    ]) {
      expect(check({ method: 'POST', headers: { [CSRF_HEADER]: '1', origin } })).toBe(true);
    }
  });

  it('applies to @Public() routes too (login CSRF): no authUser, no token -> NOT_FOUND', () => {
    expect(denial({ method: 'POST' })).toBe('NOT_FOUND');
  });

  it('@SkipCsrf() routes are exempt', () => {
    expect(check({ method: 'POST' }, { [SKIP_CSRF_KEY]: true })).toBe(true);
  });

  it('a request the auth guard accepted via Bearer is exempt', () => {
    expect(check({ method: 'PATCH', authUser: tgUser })).toBe(true);
  });

  it('a bare Authorization header does not exempt a request that is not authenticated by it', () => {
    expect(denial({ method: 'POST', headers: { authorization: 'Bearer abc' } })).toBe('NOT_FOUND');
  });

  it('a cookie-authenticated (web) request is NOT exempt', () => {
    expect(denial({ method: 'PATCH', authUser: webUser })).toBe('NOT_FOUND');
  });
});
