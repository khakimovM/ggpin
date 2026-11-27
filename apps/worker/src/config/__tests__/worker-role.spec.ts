import { EnvValidationError, loadEnv } from '../env';
import { TEST_ENV_SOURCE } from './test-env';

// D-76 (Q2): WORKER_ROLE = fulfillment | bankfeed | all. Production: required, no default, `all`
// refused. Development/test: default `all`. Exact spelling; the value is never echoed.

const PROD = { ...TEST_ENV_SOURCE, NODE_ENV: 'production' };
const PINNED_BOTS = { BANK_FEED_HUMO_BOT_ID: '111000111', BANK_FEED_UZCARD_BOT_ID: '222000222' };

function messageOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('WORKER_ROLE', () => {
  it.each(['worker', 'Bankfeed', 'FULFILLMENT', 'fulfilment', 'both'])(
    'refuses the unknown value %s without echoing it',
    (value) => {
      const message = messageOf({ ...TEST_ENV_SOURCE, WORKER_ROLE: value });
      expect(message).toContain('WORKER_ROLE: must be one of fulfillment, bankfeed, all');
      expect(message).not.toContain(`"${value}"`);
      expect(message.split('\n').some((line) => line.endsWith(value))).toBe(false);
    },
  );

  it('is required in production', () => {
    const message = messageOf({ ...PROD, FULFILLMENT_DRY_RUN: 'true', ...PINNED_BOTS });
    expect(message).toContain('WORKER_ROLE: is required in production');
  });

  it('refuses all in production', () => {
    const message = messageOf({
      ...PROD,
      WORKER_ROLE: 'all',
      FULFILLMENT_DRY_RUN: 'true',
      ...PINNED_BOTS,
    });
    expect(message).toContain('WORKER_ROLE: all is refused in production');
  });

  it('treats a blank value as unset (production: still required)', () => {
    expect(messageOf({ ...PROD, WORKER_ROLE: ' ', FULFILLMENT_DRY_RUN: 'true' })).toContain(
      'WORKER_ROLE: is required in production',
    );
  });

  it('defaults to all outside production and carries the role in the frozen config', () => {
    expect(loadEnv({ ...TEST_ENV_SOURCE }).WORKER_ROLE).toBe('all');
    expect(loadEnv({ ...TEST_ENV_SOURCE, NODE_ENV: 'development' }).WORKER_ROLE).toBe('all');
    expect(loadEnv({ ...TEST_ENV_SOURCE, WORKER_ROLE: 'bankfeed' }).WORKER_ROLE).toBe('bankfeed');
  });

  it('accepts fulfillment and bankfeed in production', () => {
    const fulfillment = loadEnv({
      ...PROD,
      WORKER_ROLE: 'fulfillment',
      FULFILLMENT_DRY_RUN: 'true',
    });
    expect(fulfillment.WORKER_ROLE).toBe('fulfillment');
    const bankfeed = loadEnv({ ...PROD, WORKER_ROLE: 'bankfeed', ...PINNED_BOTS });
    expect(bankfeed.WORKER_ROLE).toBe('bankfeed');
  });
});
