import { isNoStorePath } from '../no-store';

describe('isNoStorePath', () => {
  it.each([
    '/api/v1/auth/telegram/start',
    '/api/v1/auth/refresh',
    '/api/v1/auth/sessions/abc',
    '/api/v1/auth',
    '/api/v1/auth/telegram/status/xyz?x=1',
    '/api/v1/me',
    '/api/v1/me?foo=bar',
    '/api/v1/me/referral',
  ])('%s -> no-store', (url) => {
    expect(isNoStorePath(url)).toBe(true);
  });

  it.each([
    '/api/v1/health',
    '/api/v1/menu',
    '/api/v1/authors',
    '/api/v1/telegram/webhook',
    '/me',
    '/api/docs',
  ])('%s -> untouched', (url) => {
    expect(isNoStorePath(url)).toBe(false);
  });
});
