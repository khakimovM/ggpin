import { randomBytes } from 'node:crypto';
import { encryptSession, parseSessionKey } from '../../bank-feed/client/session-crypto';
import { loadLoginEnv } from '../bank-feed-login-env';
import { EnvValidationError, loadEnv } from '../env';
import { TEST_ENV_SOURCE } from './test-env';

const KEY = randomBytes(32).toString('base64');
const BLOB = encryptSession('TESTSESSION', parseSessionKey(KEY));
// One base64 character changed inside the ciphertext area: still valid base64, no longer authentic.
const DAMAGED = `${BLOB.slice(0, 40)}${BLOB[40] === 'A' ? 'B' : 'A'}${BLOB.slice(41)}`;
const BOTS = { BANK_FEED_HUMO_BOT_ID: '111000111', BANK_FEED_UZCARD_BOT_ID: '222000222' };
const LIVE = {
  ...BOTS,
  BANK_FEED_MODE: 'live',
  BANK_FEED_API_ID: '123456',
  BANK_FEED_API_HASH: 'ab'.repeat(16),
  BANK_FEED_SESSION_ENC: BLOB,
  BANK_FEED_ENC_KEY: KEY,
};
// Production also needs its other strong secrets; these tests only look at bank-feed problems.
const PROD = { ...TEST_ENV_SOURCE, NODE_ENV: 'production', FULFILLMENT_DRY_RUN: 'true' };

function problemsOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
    return '';
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
}

describe('worker env: bank-feed client (S7)', () => {
  it('defaults to mode off and a 20 s poll', () => {
    const env = loadEnv(TEST_ENV_SOURCE);
    expect(env.BANK_FEED_MODE).toBe('off');
    expect(env.BANK_FEED_POLL_SEC).toBe(20);
  });

  it('accepts a complete live config and parses the api id as a number', () => {
    const env = loadEnv({ ...TEST_ENV_SOURCE, ...LIVE });
    expect(env.BANK_FEED_MODE).toBe('live');
    expect(env.BANK_FEED_API_ID).toBe(123456);
  });

  it('S9-I2: fake is refused in production (a boot error)', () => {
    expect(problemsOf({ ...PROD, ...BOTS, BANK_FEED_MODE: 'fake' })).toContain(
      'BANK_FEED_MODE: fake is refused in production',
    );
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_MODE: 'fake' })).toBe('');
  });

  it('S9-I2: the same id for both bots is refused, in every environment', () => {
    const same = { BANK_FEED_HUMO_BOT_ID: '333000333', BANK_FEED_UZCARD_BOT_ID: '333000333' };
    const message = 'BANK_FEED_HUMO_BOT_ID and BANK_FEED_UZCARD_BOT_ID: must be two different bots';
    expect(problemsOf({ ...TEST_ENV_SOURCE, ...same })).toContain(message);
    expect(problemsOf({ ...PROD, ...same })).toContain(message);
  });

  it('live names every missing setting at once', () => {
    const message = problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_MODE: 'live' });
    const named = Object.keys(LIVE).filter(
      (n) => n !== 'BANK_FEED_MODE' && n !== 'BANK_FEED_ENC_KEY',
    );
    for (const name of named) {
      expect(message).toContain(`${name}: is required with BANK_FEED_MODE=live`);
    }
    expect(message).toContain(
      'BANK_FEED_ENC_KEY_FILE (or BANK_FEED_ENC_KEY outside production): is required with BANK_FEED_MODE=live',
    );
  });

  it('a wrong key or a damaged blob is a boot error that shows no value', () => {
    const otherKey = randomBytes(32).toString('base64');
    const wrong = problemsOf({ ...TEST_ENV_SOURCE, ...LIVE, BANK_FEED_ENC_KEY: otherKey });
    expect(wrong).toContain('BANK_FEED_SESSION_ENC cannot be opened with BANK_FEED_ENC_KEY');
    const damaged = problemsOf({
      ...TEST_ENV_SOURCE,
      ...LIVE,
      BANK_FEED_SESSION_ENC: DAMAGED,
    });
    expect(damaged).toContain('BANK_FEED_SESSION_ENC cannot be opened');
    const badKey = problemsOf({ ...TEST_ENV_SOURCE, ...LIVE, BANK_FEED_ENC_KEY: 'c2hvcnQ=' });
    expect(badKey).toContain('BANK_FEED_ENC_KEY must be 32 random bytes');
    for (const text of [wrong, damaged, badKey]) {
      expect(text).not.toContain(BLOB.slice(0, 20));
      expect(text).not.toContain(KEY.slice(0, 20));
      expect(text).not.toContain(otherKey.slice(0, 20));
      expect(text).not.toContain('TESTSESSION');
    }
  });

  it('rejects malformed api credentials and an out-of-range poll interval', () => {
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_API_ID: '12ab' })).toContain(
      'BANK_FEED_API_ID',
    );
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_API_HASH: 'xyz' })).toContain(
      'BANK_FEED_API_HASH',
    );
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_POLL_SEC: '1' })).toContain(
      'BANK_FEED_POLL_SEC',
    );
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_MODE: 'on' })).toContain('BANK_FEED_MODE');
  });
});

describe('loadLoginEnv (the login CLI)', () => {
  it('needs only the api credentials and the key', () => {
    const env = loadLoginEnv({
      BANK_FEED_API_ID: '123456',
      BANK_FEED_API_HASH: 'ab'.repeat(16),
      BANK_FEED_ENC_KEY: KEY,
    });
    expect(env.BANK_FEED_API_ID).toBe(123456);
  });

  it('names what is missing without values', () => {
    expect(() => loadLoginEnv({ BANK_FEED_API_HASH: 'secret-ish' })).toThrow(
      /BANK_FEED_API_ID: is required but not set[\s\S]*BANK_FEED_API_HASH: must be the 32 hex/,
    );
    try {
      loadLoginEnv({ BANK_FEED_API_HASH: 'secret-ish' });
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain('secret-ish');
    }
  });
});
