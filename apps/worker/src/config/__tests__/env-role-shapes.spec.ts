import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BANK_FEED_ROLE_SECRETS,
  FULFILLMENT_ROLE_SECRETS,
  workerRoleSecretProblems,
  type WorkerRole,
} from '@repo/shared';
import { loadHealthcheckRole } from '../healthcheck-env';
import { EnvValidationError, loadEnv } from '../env';
import type { SecretFileReader } from '../secret-file';
import { roleFlagProblems } from '../worker-role';
import { encryptSession } from '../../bank-feed/client/session-crypto';

// SA F-3: `all` is the default only when NODE_ENV is exactly development or test; a missing or
// misspelt NODE_ENV gets the production rule and no key file is opened.
// SA F-4 (b): the MTProto shape rule refuses bank-feed material under other names, and none of the
// worker's own template names trips a role rule it should not.

const DB = { DATABASE_URL: 'postgresql://ggpin:ggpin@localhost:5432/ggpin_test' };
const REDIS = { REDIS_URL: 'redis://localhost:6379' };
const KEY_FILES = {
  BANK_FEED_ENC_KEY_FILE: '/run/secrets/bf',
  WALLET_ENC_KEY_FILE: '/run/secrets/wallet',
  FRAGMENT_SESSION_ENC_KEY_FILE: '/run/secrets/fragment',
};

function spyReader(): jest.MockedFunction<SecretFileReader> {
  return jest.fn<string, [string]>().mockReturnValue(randomBytes(32).toString('base64'));
}

function messageOf(source: Record<string, string>, read?: SecretFileReader): string {
  try {
    loadEnv(source, read);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('WORKER_ROLE default needs an exact development/test NODE_ENV (SA F-3)', () => {
  const odd: readonly (readonly [string, Record<string, string>])[] = [
    ['missing', {}],
    ['misspelt', { NODE_ENV: 'prod' }],
    ['wrong case', { NODE_ENV: 'Development' }],
    ['staging', { NODE_ENV: 'staging' }],
  ];

  it.each(odd)('NODE_ENV %s, no role: refused, no key file opened', (_label, nodeEnv) => {
    const read = spyReader();
    const message = messageOf({ ...DB, ...REDIS, ...nodeEnv, ...KEY_FILES }, read);
    expect(message).toContain('WORKER_ROLE: is required');
    expect(read).not.toHaveBeenCalled();
  });

  it.each(odd)('NODE_ENV %s: all is refused', (_label, nodeEnv) => {
    expect(messageOf({ ...DB, ...REDIS, ...nodeEnv, WORKER_ROLE: 'all' })).toContain(
      'WORKER_ROLE: all is refused',
    );
  });

  it.each(odd)('NODE_ENV %s with a valid role: still no key file opened', (_label, nodeEnv) => {
    const read = spyReader();
    messageOf(
      { ...DB, ...REDIS, ...nodeEnv, WORKER_ROLE: 'bankfeed', BANK_FEED_ENC_KEY_FILE: '/x' },
      read,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('development and test keep the all default', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadEnv({ ...DB, ...REDIS, NODE_ENV }).WORKER_ROLE).toBe('all');
    }
  });

  it('the HEALTHCHECK follows the same rule', () => {
    expect(loadHealthcheckRole({})).toBeNull();
    expect(loadHealthcheckRole({ NODE_ENV: 'staging' })).toBeNull();
    expect(loadHealthcheckRole({ NODE_ENV: '', WORKER_ROLE: 'all' })).toBeNull();
    expect(loadHealthcheckRole({ NODE_ENV: 'prod', WORKER_ROLE: 'bankfeed' })).toBe('bankfeed');
    expect(loadHealthcheckRole({ NODE_ENV: 'test' })).toBe('all');
  });
});

/** Every variable name in apps/worker/.env.example, set or commented out. */
function templateNames(): string[] {
  const text = readFileSync(join(__dirname, '../../../.env.example'), 'utf8');
  const names = [...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? '');
  return [...new Set(names)].sort();
}

function refusedIn(role: WorkerRole, names: readonly string[]): string[] {
  return names.filter((name) => workerRoleSecretProblems(role, { [name]: 'x' }).length > 0).sort();
}

describe('role rules against the worker template (SA F-4)', () => {
  it('reads a full template', () => {
    expect(templateNames().length).toBeGreaterThan(40);
    expect(templateNames()).toContain('TON_API_KEY');
  });

  it('fulfillment refuses exactly the bankfeed secrets and api id of the template', () => {
    expect(refusedIn('fulfillment', templateNames())).toEqual(
      [...BANK_FEED_ROLE_SECRETS, 'BANK_FEED_API_ID'].sort(),
    );
  });

  it('bankfeed refuses exactly the fulfillment secrets of the template', () => {
    expect(refusedIn('bankfeed', templateNames())).toEqual([...FULFILLMENT_ROLE_SECRETS].sort());
  });

  it.each(['BANKFEED_API_HASH', 'TG_API_HASH', 'MTPROTO_SESSION', 'BANKFEED_SESSION_ENC'])(
    'fulfillment refuses bank-feed material named %s',
    (name) => {
      expect(
        messageOf({ ...DB, ...REDIS, NODE_ENV: 'test', WORKER_ROLE: 'fulfillment', [name]: 'x' }),
      ).toContain(`${name}: belongs to the bankfeed container`);
    },
  );
});

/** The variables a deploy env template (deploy/env/<file>) SETS, with their values. */
function deployTemplate(file: string): Record<string, string> {
  const text = readFileSync(join(__dirname, '../../../../../deploy/env', file), 'utf8');
  return Object.fromEntries(
    [...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

// The other side's settings, as in worker-role-settings-static.spec.ts: a template that carries
// them was copied from the wrong container (D-76: one side never reads the other's values).
const BANKFEED_SETTING = /^(TOPUP_[A-Z_]+|BANK_TIME_SKEW_SEC|BANK_FEED_[A-Z_]+)$/;
const FULFILLMENT_SETTING =
  /^(TON_[A-Z_]+|FRAGMENT_[A-Z_]+|SUPPLIER_MAX_PER_ORDER_MICRO_USDT|PRICE_TOLERANCE_BPS|FULFILLMENT_DRY_RUN|ORDER_RECONCILE_EVERY_MS|HELD_MAX_AGE_MS|RESELLER_[A-Z_]+)$/;

describe('deploy env templates against their container role (CR #3, SA D-1)', () => {
  const cases = [
    ['worker.env.example', 'fulfillment', BANKFEED_SETTING],
    ['bankfeed.env.example', 'bankfeed', FULFILLMENT_SETTING],
  ] as const;

  it.each(cases)('%s is read in full', (file) => {
    expect(Object.keys(deployTemplate(file)).length).toBeGreaterThan(10);
  });

  it.each(cases)('%s: the %s boot refuses none of its names or flags', (file, role) => {
    const env = deployTemplate(file);
    expect(refusedIn(role, Object.keys(env))).toEqual([]);
    expect(roleFlagProblems(role, env)).toEqual([]);
  });

  it.each(cases)('%s: no setting of the other side (%s)', (file, _role, other) => {
    expect(Object.keys(deployTemplate(file)).filter((name) => other.test(name))).toEqual([]);
  });

  it('the rules do refuse a wrong template (the check is not vacuous)', () => {
    expect(refusedIn('fulfillment', Object.keys(deployTemplate('bankfeed.env.example')))).toContain(
      'BANK_FEED_API_HASH',
    );
    expect(refusedIn('bankfeed', Object.keys(deployTemplate('worker.env.example')))).toContain(
      'TON_MNEMONIC_ENC',
    );
  });
});

// CR #8: the deploy templates, their placeholders filled with synthetic values of the right shape
// (low-entropy fakes from the .gitleaks.toml test allowlist, never realistic-looking keys),
// plus what compose sets (NODE_ENV, WORKER_ROLE, the *_FILE paths), boot in production. A template
// that misses a required name, or carries one the boot refuses, fails here before it reaches a VPS.
const SYNTHETIC: Record<string, string> = {
  DATABASE_URL: 'postgresql://ggpin_runtime:secret@postgres:5432/ggpin',
  TON_API_ENDPOINT: 'https://toncenter.example.org/api/v2/jsonRPC',
  TON_API_KEY: 'ab'.repeat(32),
  TON_MNEMONIC_ENC: `v1.${randomBytes(12).toString('base64url')}.${randomBytes(160).toString('base64url')}`,
  BANK_FEED_API_ID: '27182818',
  BANK_FEED_API_HASH: 'ab'.repeat(16),
  BANK_FEED_HUMO_BOT_ID: '856254490',
  BANK_FEED_UZCARD_BOT_ID: '915326936',
};

function filledTemplate(file: string): Record<string, string> {
  const env = deployTemplate(file);
  for (const [name, value] of Object.entries(env)) {
    if (name === 'REDIS_URL') env[name] = value.replace(/<[^>]+>/, 'secret');
    else if (/[<>]/.test(value) || name in SYNTHETIC) {
      const synthetic = SYNTHETIC[name];
      if (synthetic === undefined) throw new Error(`no synthetic value for ${name} in ${file}`);
      env[name] = synthetic;
    }
  }
  return env;
}

/** One synthetic key file for every *_FILE, and the session sealed with it as the login CLI does. */
const SYNTHETIC_KEY = randomBytes(32);
const keyReader: SecretFileReader = () => SYNTHETIC_KEY.toString('base64');
SYNTHETIC.BANK_FEED_SESSION_ENC = encryptSession('synthetic-mtproto-session', SYNTHETIC_KEY);

describe('deploy env templates boot in production with synthetic values (CR #8)', () => {
  it('worker.env.example + compose -> WORKER_ROLE=fulfillment boots', () => {
    const env = {
      ...filledTemplate('worker.env.example'),
      NODE_ENV: 'production',
      WORKER_ROLE: 'fulfillment',
      BANK_FEED_MODE: 'off',
      WALLET_ENC_KEY_FILE: '/run/secrets/wallet_enc_key',
      FRAGMENT_SESSION_ENC_KEY_FILE: '/run/secrets/fragment_session_enc_key',
    };
    const loaded = loadEnv(env, keyReader);
    expect(loaded.WORKER_ROLE).toBe('fulfillment');
  });

  it('bankfeed.env.example + compose -> WORKER_ROLE=bankfeed boots', () => {
    const env = {
      ...filledTemplate('bankfeed.env.example'),
      NODE_ENV: 'production',
      WORKER_ROLE: 'bankfeed',
      BANK_FEED_ENC_KEY_FILE: '/run/secrets/bank_feed_enc_key',
    };
    const loaded = loadEnv(env, keyReader);
    expect(loaded.WORKER_ROLE).toBe('bankfeed');
  });
});
