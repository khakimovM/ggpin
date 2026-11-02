import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHttpTestApp } from './create-http-test-app';

const BASE = '/api/v1/pipeline-test';

// D-26: a refusal that is not a business 403 must look like a missing resource.
describe('403 handling in the real pipeline', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 1000 } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('a guard that returns false -> 404 NOT_FOUND in the envelope (not 500, not 403)', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/guard-denied` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'errors.NOT_FOUND' },
    });
    expect(res.body).not.toContain('Forbidden');
    expect(res.body).not.toContain('reached');
  });

  it('AppError USER_BLOCKED keeps 403 and its own code', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/blocked-user` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'USER_BLOCKED', message: 'errors.USER_BLOCKED' },
    });
  });
});
