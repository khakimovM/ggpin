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
