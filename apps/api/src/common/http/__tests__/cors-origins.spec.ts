import { CSRF_HEADER, PAY_TOKEN_HEADER } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import {
  PAY_VIEW_PATH_PREFIX,
  corsOrigins,
  corsPolicyFor,
  defaultCorsPolicy,
  payViewCorsPolicy,
} from '../cors-origins';

describe('corsOrigins', () => {
  it('is exactly WEB_URL and ADMIN_URL by default', () => {
    expect(corsOrigins(buildTestEnv())).toEqual(['http://localhost:3000', 'http://localhost:5173']);
  });

  it('adds nothing when the Mini App lives on the web origin', () => {
    const env = buildTestEnv({ MINI_APP_URL: 'http://localhost:3000/tg' });
    expect(corsOrigins(env)).toEqual(['http://localhost:3000', 'http://localhost:5173']);
  });

  it('adds only the origin (no path) of a distinct Mini App URL', () => {
    const env = buildTestEnv({ MINI_APP_URL: 'https://miniapp.example.uz/tg?x=1' });
    expect(corsOrigins(env)).toEqual([
      'http://localhost:3000',
      'http://localhost:5173',
      'https://miniapp.example.uz',
    ]);
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
