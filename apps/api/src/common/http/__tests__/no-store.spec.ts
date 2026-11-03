import { isNoStoreRoute } from '../no-store';

describe('isNoStoreRoute (matched route pattern)', () => {
  it.each([
    '/api/v1/auth/telegram/start',
    '/api/v1/auth/refresh',
    '/api/v1/auth/sessions/:id',
    '/api/v1/auth/telegram/status/:nonce',
    '/api/v1/auth',
    '/api/v1/me',
    '/api/v1/me/referral',
  ])('%s -> no-store', (route) => {
    expect(isNoStoreRoute(route)).toBe(true);
  });

  it('no route matched (a 404) -> no-store', () => {
    expect(isNoStoreRoute(undefined)).toBe(true);
  });

  it.each([
    '/api/v1/health/live',
    '/api/v1/menu',
    '/api/v1/authors',
    '/api/v1/telegram/webhook',
    '/me',
    '/api/docs',
  ])('%s -> untouched', (route) => {
    expect(isNoStoreRoute(route)).toBe(false);
  });
});
