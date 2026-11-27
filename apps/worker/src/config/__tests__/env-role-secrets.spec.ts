import { randomBytes } from 'node:crypto';
import { BANK_FEED_ROLE_SECRETS, FULFILLMENT_ROLE_SECRETS } from '@repo/shared';
import { EnvValidationError, loadEnv, loadProcessEnv } from '../env';
import type { SecretFileReader } from '../secret-file';
import { TEST_ENV_SOURCE } from './test-env';

// D-76: each role refuses the other container's secrets by name, BEFORE any key file is read,
// and never calls the other side's key loader (the file is not even opened).

const VALUE = 'S3cr3t-VALUE-that-must-never-be-printed-9f8e7d';
const PROD = { ...TEST_ENV_SOURCE, NODE_ENV: 'production' };
const PINNED_BOTS = { BANK_FEED_HUMO_BOT_ID: '111000111', BANK_FEED_UZCARD_BOT_ID: '222000222' };
const FULFILLMENT = { ...TEST_ENV_SOURCE, WORKER_ROLE: 'fulfillment' };
const BANKFEED = { ...TEST_ENV_SOURCE, WORKER_ROLE: 'bankfeed' };

function spyReader(): jest.MockedFunction<SecretFileReader> {
  const key = randomBytes(32).toString('base64');
  return jest.fn<string, [string]>().mockReturnValue(key);
}

function problemsOf(source: Record<string, string>, read?: SecretFileReader): string {
  try {
    loadEnv(source, read);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('role secret separation', () => {
  it.each([...BANK_FEED_ROLE_SECRETS, 'BANK_FEED_API_ID'])(
    'fulfillment refuses %s by name, never by value',
    (name) => {
      const message = problemsOf({ ...FULFILLMENT, [name]: VALUE }, spyReader());
      expect(message).toContain(`${name}: belongs to the bankfeed container`);
      expect(message).not.toContain(VALUE);
    },
  );

  it.each([...FULFILLMENT_ROLE_SECRETS, 'FAZERCARDS_API_KEY', 'TONCENTER_API_KEY'])(
    'bankfeed refuses %s by name (list and prefix rule), never by value',
    (name) => {
      const message = problemsOf({ ...BANKFEED, [name]: VALUE }, spyReader());
      expect(message).toContain(`${name}: belongs to the fulfillment container`);
      expect(message).not.toContain(VALUE);
    },
  );

  it('fulfillment never opens the bank-feed key file', () => {
    const read = spyReader();
    const message = problemsOf({ ...FULFILLMENT, BANK_FEED_ENC_KEY_FILE: '/run/secrets/bf' }, read);
    expect(message).toContain('BANK_FEED_ENC_KEY_FILE: belongs to the bankfeed container');
    expect(read).not.toHaveBeenCalled();
  });

  it('bankfeed never opens the wallet or Fragment key file, even with FULFILLMENT_DRY_RUN=false', () => {
    const read = spyReader();
    const message = problemsOf(
      {
        ...BANKFEED,
        FULFILLMENT_DRY_RUN: 'false',
        WALLET_ENC_KEY_FILE: '/run/secrets/wallet',
        FRAGMENT_SESSION_ENC_KEY_FILE: '/run/secrets/fragment',
      },
      read,
    );
    expect(message).toContain('WALLET_ENC_KEY_FILE: belongs to the fulfillment container');
    expect(message).toContain(
      'FRAGMENT_SESSION_ENC_KEY_FILE: belongs to the fulfillment container',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('an invalid role opens no key file at all', () => {
    const read = spyReader();
    problemsOf({ ...TEST_ENV_SOURCE, WORKER_ROLE: 'nope', BANK_FEED_ENC_KEY_FILE: '/x' }, read);
    expect(read).not.toHaveBeenCalled();
  });

  it('bankfeed still reads its own key file (and all reads it too)', () => {
    const read = spyReader();
    const env = loadEnv({ ...BANKFEED, BANK_FEED_ENC_KEY_FILE: '/run/secrets/bf' }, read);
    expect(read).toHaveBeenCalledWith('/run/secrets/bf');
    expect(env.BANK_FEED_ENC_KEY).toBeDefined();
    const all = spyReader();
    loadEnv({ ...TEST_ENV_SOURCE, BANK_FEED_ENC_KEY_FILE: '/run/secrets/bf' }, all);
    expect(all).toHaveBeenCalledTimes(1);
  });

  it.each(['fake', 'live'])('fulfillment refuses BANK_FEED_MODE=%s', (mode) => {
    expect(problemsOf({ ...FULFILLMENT, BANK_FEED_MODE: mode })).toContain(
      'BANK_FEED_MODE: must be off (or unset) with WORKER_ROLE=fulfillment',
    );
  });

  it('fulfillment accepts BANK_FEED_MODE=off and ignores the non-secret bank-feed knobs', () => {
    const env = loadEnv({ ...FULFILLMENT, BANK_FEED_MODE: 'off', ...PINNED_BOTS });
    expect(env.BANK_FEED_MODE).toBe('off');
    expect(env.BANK_FEED_ENC_KEY).toBeUndefined();
  });

  it.each(['false', 'yes'])('bankfeed refuses FULFILLMENT_DRY_RUN=%s', (value) => {
    expect(problemsOf({ ...BANKFEED, FULFILLMENT_DRY_RUN: value })).toContain(
      'FULFILLMENT_DRY_RUN: must be true (or unset) with WORKER_ROLE=bankfeed',
    );
  });

  it('bankfeed in production needs no FULFILLMENT_DRY_RUN and holds no wallet material', () => {
    const env = loadEnv({ ...PROD, WORKER_ROLE: 'bankfeed', ...PINNED_BOTS });
    expect(env.FULFILLMENT_DRY_RUN).toBe(true);
    expect(env.TON_WALLET_SECRET).toBeUndefined();
    expect(env.TON_API_KEY).toBeUndefined();
    expect(env.FRAGMENT_SESSION_ENC_KEY).toBeUndefined();
  });

  it('fulfillment in production does not need the pinned bank-bot ids (no matcher there)', () => {
    const env = loadEnv({ ...PROD, WORKER_ROLE: 'fulfillment', FULFILLMENT_DRY_RUN: 'true' });
    expect(env.WORKER_ROLE).toBe('fulfillment');
  });

  it('fulfillment in production still requires FULFILLMENT_DRY_RUN to be explicit', () => {
    expect(problemsOf({ ...PROD, WORKER_ROLE: 'fulfillment' })).toContain(
      'FULFILLMENT_DRY_RUN: is required but not set',
    );
  });

  it('loadProcessEnv forgets every key variable whatever the role, also when refused', () => {
    const source: NodeJS.ProcessEnv = {
      ...FULFILLMENT,
      NODE_ENV: 'development',
      BANK_FEED_ENC_KEY: VALUE,
      BANK_FEED_ENC_KEY_FILE: '/x',
      WALLET_ENC_KEY: VALUE,
      WALLET_ENC_KEY_FILE: '/y',
      TON_MNEMONIC_ENC: VALUE,
      TON_API_KEY: VALUE,
      FRAGMENT_SESSION_ENC_KEY: VALUE,
      FRAGMENT_SESSION_ENC_KEY_FILE: '/z',
    };
    expect(() => loadProcessEnv(source)).toThrow(EnvValidationError);
    const forgotten = Object.keys(source).filter(
      (name) => name.includes('KEY') || name.includes('MNEMONIC'),
    );
    expect(forgotten).toEqual([]);
  });
});
