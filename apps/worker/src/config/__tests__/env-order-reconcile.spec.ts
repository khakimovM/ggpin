import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvValidationError, loadEnv } from '../env';
import { TEST_ENV_SOURCE } from './test-env';

// D-64 (10): the two owner-approved knobs of the order reconciler (phase 5 S9).

function problemsOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
    return '';
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
}

describe('worker env: the order reconciler (S9)', () => {
  it('defaults to a 10-minute tick and a 6-hour HELD limit', () => {
    const env = loadEnv({ ...TEST_ENV_SOURCE });
    expect(env.ORDER_RECONCILE_EVERY_MS).toBe(600_000);
    expect(env.HELD_MAX_AGE_MS).toBe(21_600_000);
  });

  it('refuses a tick shorter than a minute', () => {
    const set = (value: string) => ({ ...TEST_ENV_SOURCE, ORDER_RECONCILE_EVERY_MS: value });
    expect(loadEnv(set('60000')).ORDER_RECONCILE_EVERY_MS).toBe(60_000);
    expect(problemsOf(set('59999'))).toContain('ORDER_RECONCILE_EVERY_MS');
    expect(problemsOf(set('600000.5'))).toContain('ORDER_RECONCILE_EVERY_MS');
    expect(problemsOf(set('ten minutes'))).toContain('ORDER_RECONCILE_EVERY_MS');
  });

  it('refuses a HELD limit shorter than an hour', () => {
    const set = (value: string) => ({ ...TEST_ENV_SOURCE, HELD_MAX_AGE_MS: value });
    expect(loadEnv(set('3600000')).HELD_MAX_AGE_MS).toBe(3_600_000);
    expect(problemsOf(set('3599999'))).toContain('HELD_MAX_AGE_MS');
    expect(problemsOf(set('-1'))).toContain('HELD_MAX_AGE_MS');
  });

  it('documents both, with their defaults, in the worker template', () => {
    const template = readFileSync(join(__dirname, '../../../.env.example'), 'utf8');
    expect(template).toMatch(/^ORDER_RECONCILE_EVERY_MS=600000$/m);
    expect(template).toMatch(/^HELD_MAX_AGE_MS=21600000$/m);
  });
});
