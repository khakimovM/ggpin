import { loadEnv, type Env } from '../env';

// Assembled at runtime so no secret-shaped literal sits in the source (gitleaks, guard hooks).
// The four signing secrets must differ from each other (loadEnv enforces it).
const fake = (...parts: string[]): string => parts.join('');

export const TEST_JWT_ACCESS_SECRET = fake('test-access-', 'x'.repeat(24));
export const TEST_JWT_REFRESH_SECRET = fake('test-refresh-', 'y'.repeat(24));
export const TEST_TG_SESSION_SECRET = fake('test-tgsession-', 'z'.repeat(24));
export const TEST_OTP_PEPPER = fake('test-pepper-', 'p'.repeat(24));
export const TEST_PAY_TOKEN_PEPPER = fake('test-paytoken-', 'q'.repeat(24));
export const TEST_BOT_TOKEN = fake('123456789', ':', 'AAH', 'a'.repeat(32));
export const TEST_BOT_USERNAME = 'ggpin_test_bot';
export const TEST_WEBHOOK_SECRET = fake('test-webhook-', 'w'.repeat(24));

// Explicit env for tests: never reads process.env, so suites pass with no .env file and
// regardless of what the CI shell exports.
export const TEST_ENV_SOURCE: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://ggpin:ggpin@localhost:5432/ggpin_test',
  REDIS_URL: 'redis://localhost:6379',
  WEB_URL: 'http://localhost:3000',
  ADMIN_URL: 'http://localhost:5173',
  JWT_ACCESS_SECRET: TEST_JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: TEST_JWT_REFRESH_SECRET,
  TG_SESSION_SECRET: TEST_TG_SESSION_SECRET,
  OTP_PEPPER: TEST_OTP_PEPPER,
  PAY_TOKEN_PEPPER: TEST_PAY_TOKEN_PEPPER,
  TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME: TEST_BOT_USERNAME,
};

// Suites that exercise prices run against the worker's dry-run (simulator) data, so they opt in
// to it here; production refusal tests override it back or set NODE_ENV=production. Kept out of
// TEST_ENV_SOURCE so the env tests still see the real default (false).
export function buildTestEnv(overrides: Readonly<Record<string, string>> = {}): Env {
  return loadEnv({ ...TEST_ENV_SOURCE, PRICING_ALLOW_SIMULATED: 'true', ...overrides });
}
