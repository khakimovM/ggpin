import { describe, expect, it } from 'vitest';
import {
  API_ONLY_SECRETS,
  WORKER_ENV_PREFIXES,
  WORKER_ONLY_SECRETS,
  apiSecretProblems,
  isBlank,
  isWorkerOnlySecretName,
  placeholderReason,
  productionSecretProblems,
  workerSecretProblems,
} from './env-secrets';

const VALUE = 'S3cr3t-value-that-must-not-be-printed';

// Names the re-audit verified as missed (RA-10), plus the shapes the rules must keep refusing.
const MUST_REFUSE = [
  ...WORKER_ONLY_SECRETS,
  'FAZERCARDS_API_KEY',
  'TONCENTER_API_KEY',
  'TONAPI_KEY',
  'MOOGOLD_SECRET',
  'HOT_WALLET_SECRET',
  'STEAM_API_KEY',
  'PUBG_API_KEY',
  'UNIPIN_SECRET',
  'SMILEONE_TOKEN',
  'STEL_SSID',
  'STEL_DT',
  'STEL_TON_TOKEN',
  'FRAGMENT_HASH',
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
  'APP_SEED_PHRASE',
  'SEEDPHRASE',
  'ROBLOX_COOKIE',
];

// Legitimate names that previously stopped the API from booting, generic developer-shell
// variables that must never break it, and the worker's own non-secret settings.
const MUST_ALLOW = [
  'COOKIE_SECRET',
  'COOKIE_DOMAIN',
  'SESSION_COOKIE_NAME',
  'SESSION_COOKIE_DOMAIN',
  'JWT_PRIVATE_KEY',
  'VAPID_PRIVATE_KEY',
  'PYTHONHASHSEED',
  'SSH_PRIVATE_KEY',
  'DB_SEED',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'SENTRY_AUTH_TOKEN',
  'TON_NETWORK',
  'TON_API_ENDPOINT',
  'TON_MAX_PER_ORDER_NANO',
  'TON_MAX_DAILY_NANO',
  'TON_MIN_BALANCE_ALERT_NANO',
  'RESELLER_STARS_API_URL',
  'SUPPLIER_MAX_PER_ORDER_MICRO_USDT',
  'FRAGMENT_BASE_URL',
  'STEAM_COMPAT_CLIENT_INSTALL_PATH',
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'API_PORT',
];

describe('isWorkerOnlySecretName', () => {
  it.each(MUST_REFUSE)('%s is worker-only', (name) => {
    expect(isWorkerOnlySecretName(name)).toBe(true);
  });

  it.each(MUST_ALLOW)('%s is not', (name) => {
    expect(isWorkerOnlySecretName(name)).toBe(false);
  });

  it('boots in a developer shell that has unrelated credentials', () => {
    const shell = {
      GITHUB_TOKEN: VALUE,
      NPM_TOKEN: VALUE,
      AWS_SECRET_ACCESS_KEY: VALUE,
      SSH_PRIVATE_KEY: VALUE,
      PYTHONHASHSEED: '0',
      COOKIE_SECRET: VALUE,
      JWT_PRIVATE_KEY: VALUE,
    };
    expect(workerSecretProblems(shell)).toEqual([]);
  });

  it('every documented worker prefix refuses a secret-shaped name', () => {
    for (const prefix of WORKER_ENV_PREFIXES) {
      expect(isWorkerOnlySecretName(prefix + 'API_KEY')).toBe(true);
      expect(isWorkerOnlySecretName(prefix + 'BASE_URL')).toBe(prefix === 'STEL_');
    }
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
