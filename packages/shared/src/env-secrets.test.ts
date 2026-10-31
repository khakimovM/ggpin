import { describe, expect, it } from 'vitest';
import {
  API_ONLY_SECRETS,
  WORKER_ONLY_SECRETS,
  apiSecretProblems,
  isBlank,
  isWorkerOnlySecretName,
  placeholderReason,
  productionSecretProblems,
  workerSecretProblems,
} from './env-secrets';

const VALUE = 'S3cr3t-value-that-must-not-be-printed';

describe('isWorkerOnlySecretName', () => {
  it.each([
    ...WORKER_ONLY_SECRETS,
    'SUPPLIER_PUBG_API_KEY',
    'SUPPLIER_STEAM_SECRET',
    'TON_WALLET_PRIVATE_KEY',
    'TON_ACCESS_TOKEN',
    'WALLET_PASSWORD',
    'WALLET_SEED',
    'FRAGMENT_COOKIES',
    'FRAGMENT_SESSION_ENC',
    'RESELLER_PREMIUM_API_KEY',
    'ton_mnemonic',
    'SOMETHING_MNEMONIC',
    'MY_PRIVATE_KEY',
    'APP_SEED_PHRASE',
    'SESSION_COOKIE',
  ])('%s is worker-only', (name) => {
    expect(isWorkerOnlySecretName(name)).toBe(true);
  });

  it.each([
    'TON_NETWORK',
    'TON_API_ENDPOINT',
    'TON_MAX_PER_ORDER_NANO',
    'TON_MAX_DAILY_NANO',
    'TON_MIN_BALANCE_ALERT_NANO',
    'RESELLER_STARS_API_URL',
    'SUPPLIER_MAX_PER_ORDER_MICRO_USDT',
    'FRAGMENT_BASE_URL',
    'DATABASE_URL',
    'JWT_ACCESS_SECRET',
    'API_PORT',
  ])('%s is not', (name) => {
    expect(isWorkerOnlySecretName(name)).toBe(false);
  });
});

describe('workerSecretProblems / apiSecretProblems', () => {
  it('names the variable, never the value, and skips blanks', () => {
    const problems = workerSecretProblems({
      SUPPLIER_PUBG_API_KEY: VALUE,
      WALLET_ENC_KEY: '  ',
      TON_NETWORK: 'testnet',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SUPPLIER_PUBG_API_KEY');
    expect(problems.join()).not.toContain(VALUE);
  });

  it('rejects each API-only secret in the worker', () => {
    for (const name of API_ONLY_SECRETS) {
      const problems = apiSecretProblems({ [name]: VALUE });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(name);
      expect(problems[0]).not.toContain(VALUE);
    }
    expect(apiSecretProblems({ TON_API_KEY: VALUE, LOG_LEVEL: 'info' })).toEqual([]);
  });
});

describe('placeholder policy', () => {
  it('isBlank', () => {
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('  ')).toBe(true);
    expect(isBlank('x')).toBe(false);
  });

  it('placeholderReason', () => {
    expect(placeholderReason('change-me-x', null)).toContain('change-me');
    expect(placeholderReason('<token>', null)).toContain('<...>');
    expect(placeholderReason('short', 32)).toContain('minimum 32');
    expect(placeholderReason('short', null)).toBeNull();
    expect(placeholderReason('a'.repeat(32), 32)).toBeNull();
  });

  it('productionSecretProblems applies length only to generated secrets', () => {
    const problems = productionSecretProblems(
      { GEN: 'short', ISS: 'short', BAD: '<x>' },
      ['GEN'],
      ['ISS', 'BAD', 'MISSING'],
    );
    expect(problems.map((p) => p.split(':')[0])).toEqual(['GEN', 'BAD']);
  });
});
