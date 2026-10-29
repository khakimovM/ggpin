import { loadEnv, type Env } from '../env';

// Explicit env for tests: never reads process.env, so suites pass with no .env file and
// regardless of what the CI shell exports.
export const TEST_ENV_SOURCE: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://ggpin:ggpin@localhost:5432/ggpin_test',
  REDIS_URL: 'redis://localhost:6379',
};

export function buildTestEnv(overrides: Readonly<Record<string, string>> = {}): Env {
  return loadEnv({ ...TEST_ENV_SOURCE, ...overrides });
}
