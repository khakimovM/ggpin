import { CSRF_HEADER, PAY_TOKEN_HEADER } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import {
  ADMIN_PATH,
  PAY_VIEW_PATH_PREFIX,
  adminCorsPolicy,
  corsOrigins,
  corsPolicyFor,
  defaultCorsPolicy,
  payViewCorsPolicy,
} from '../cors-origins';

describe('corsOrigins (the user routes, SA-H2: never the admin origin)', () => {
  it('is exactly WEB_URL by default', () => {
    expect(corsOrigins(buildTestEnv())).toEqual(['http://localhost:3000']);
  });

  it('adds nothing when the Mini App lives on the web origin', () => {
    const env = buildTestEnv({ MINI_APP_URL: 'http://localhost:3000/tg' });
    expect(corsOrigins(env)).toEqual(['http://localhost:3000']);
  });

  it('adds only the origin (no path) of a distinct Mini App URL', () => {
    const env = buildTestEnv({ MINI_APP_URL: 'https://miniapp.example.uz/tg?x=1' });
    expect(corsOrigins(env)).toEqual(['http://localhost:3000', 'https://miniapp.example.uz']);
  });

  it('never lists ADMIN_URL', () => {
    const env = buildTestEnv({ MINI_APP_URL: 'https://miniapp.example.uz/tg' });
    expect(corsOrigins(env)).not.toContain(env.ADMIN_URL);
    expect(defaultCorsPolicy(env).origin).not.toContain(env.ADMIN_URL);
  });
});

describe('per-path CORS policy (SA-H2 admin routes)', () => {
  const env = buildTestEnv({ MINI_APP_URL: 'https://miniapp.example.uz/tg' });

  it('the admin policy: ADMIN_URL only, credentialed, no Authorization, no DELETE', () => {
    expect(adminCorsPolicy(env)).toEqual({
      origin: ['http://localhost:5173'],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Idempotency-Key', CSRF_HEADER],
      exposedHeaders: ['Retry-After', 'X-Request-Id'],
      maxAge: 600,
    });
  });

  it.each([
    ['/api/v1/admin', true],
    ['/api/v1/admin/auth/me', true],
    ['/api/v1/admin/auth/status/x?y=1', true],
    ['/api/v1/admin/unknown/path', true],
    // The router decodes escapes before matching, so the decoded path decides too.
    ['/api/v1/%61dmin/auth/me', true],
    ['/api/v1/admin%2Fauth%2Fme', true],
    ['/api/v1/administrator', false],
    ['/api/v1/admins', false],
    ['/api/v1/auth/telegram/start', false],
    ['/api/v1/payments/intents?next=/api/v1/admin/auth/me', false],
    ['/api/v1/%zz/admin', false],
    ['/API/v1/admin/auth/me', false],
  ])('%s -> admin policy %s', (url, isAdmin) => {
    expect(corsPolicyFor(env, url)).toEqual(isAdmin ? adminCorsPolicy(env) : expect.anything());
    expect(corsPolicyFor(env, url).origin.includes(env.ADMIN_URL)).toBe(isAdmin);
  });

  it('ADMIN_PATH is built from the served prefix and version', () => {
    expect(ADMIN_PATH).toBe('/api/v1/admin');
  });
});

describe('per-path CORS policy (D-39 pay view)', () => {
  const env = buildTestEnv({ MINI_APP_URL: 'https://miniapp.example.uz/tg' });

  it('the default policy is credentialed and never allows the pay-token header', () => {
    const policy = defaultCorsPolicy(env);
    expect(policy.credentials).toBe(true);
    expect(policy.allowedHeaders).toContain(CSRF_HEADER);
    expect(policy.allowedHeaders).not.toContain(PAY_TOKEN_HEADER);
  });

  it('the pay view: WEB_URL only, no credentials, GET only, the token header only', () => {
    expect(payViewCorsPolicy(env)).toEqual({
      origin: ['http://localhost:3000'],
      credentials: false,
      methods: ['GET', 'OPTIONS'],
      allowedHeaders: [PAY_TOKEN_HEADER],
      exposedHeaders: ['Retry-After', 'X-Request-Id'],
      maxAge: 600,
    });
  });

  it.each([
    ['/api/v1/payments/pay/intent_1', true],
    ['/api/v1/payments/pay/intent_1?x=1', true],
    ['/api/v1/payments/pay/', true],
    ['/api/v1/payments/pay', false],
    ['/api/v1/payments/intents', false],
    ['/api/v1/payments/intents?next=/api/v1/payments/pay/x', false],
    // Only the raw path counts: an encoded form gets the default policy (no token header).
    ['/api/v1/payments/%70ay/intent_1', false],
    ['/API/v1/payments/pay/intent_1', false],
  ])('%s -> pay policy %s', (url, isPay) => {
    expect(corsPolicyFor(env, url)).toEqual(
      isPay ? payViewCorsPolicy(env) : defaultCorsPolicy(env),
    );
  });
});

describe('PAY_VIEW_PATH_PREFIX', () => {
  it('is built from the served prefix and version (app.setup.ts uses the same constants)', () => {
    expect(PAY_VIEW_PATH_PREFIX).toBe('/api/v1/payments/pay/');
  });
});
