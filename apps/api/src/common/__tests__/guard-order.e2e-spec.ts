import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHttpTestApp } from './create-http-test-app';

// The global guards must run Throttler -> UserAuthGuard -> CsrfGuard. Nest orders APP_GUARDs by
// module registration, so this is proven by behaviour, not by reading the module list: each
// case is only true for one order. No database is needed (unauthenticated requests never load
// a user).
describe('global guard order', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('throttler runs before auth: the 3rd unauthenticated call is 429, not 401', async () => {
    app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode);
    }
    // If auth ran first the third call would also be 401.
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('auth runs before CSRF: a state-changing call with no session and no CSRF header is 401, not 404', async () => {
    app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 1000 } });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/me', payload: { locale: 'ru' } });
    // If CSRF ran first this would be the D-26 404.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('CSRF runs on a @Public() route after auth was skipped: no X-CSRF-Token -> 404', async () => {
    app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 1000 } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/telegram/webapp',
      payload: { initData: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('health stays public (no session, no CSRF concerns)', async () => {
    app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 1000 } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
