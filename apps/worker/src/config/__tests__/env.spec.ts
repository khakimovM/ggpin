import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_ONLY_SECRETS,
  WORKER_PRODUCTION_GENERATED_SECRETS as PRODUCTION_GENERATED_SECRETS,
  WORKER_PRODUCTION_ISSUED_CREDENTIALS as PRODUCTION_ISSUED_CREDENTIALS,
} from '@repo/shared';
import { EnvValidationError, loadEnv, loadProcessEnv } from '../env';
import { TEST_ENV_SOURCE, buildTestEnv } from './test-env';

const SECRET_VALUE = 'S3cr3t-VALUE-that-must-never-be-printed-9f8e7d';
const LONG_SECRET = 'a'.repeat(40);

function messageOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('worker loadEnv', () => {
  it('applies safe defaults outside production', () => {
    const env = buildTestEnv();
    expect(env).toMatchObject({
      FULFILLMENT_DRY_RUN: true,
      TON_NETWORK: 'testnet',
      LOG_LEVEL: 'info',
      TON_MAX_PER_ORDER_NANO: 50000000000n,
      TON_MAX_DAILY_NANO: 500000000000n,
      TON_MIN_BALANCE_ALERT_NANO: 100000000000n,
      SUPPLIER_MAX_PER_ORDER_MICRO_USDT: 200000000n,
      PRICE_TOLERANCE_BPS: 300,
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('names every missing required variable at once', () => {
    const message = messageOf({ NODE_ENV: 'test' });
    expect(message).toContain('DATABASE_URL: is required but not set');
    expect(message).toContain('REDIS_URL: is required but not set');
  });

  it('requires NODE_ENV: no default, so a forgotten value cannot become development', () => {
    const { NODE_ENV: _removed, ...without } = TEST_ENV_SOURCE;
    expect(messageOf(without)).toContain('NODE_ENV: is required but not set');
    expect(messageOf({ ...TEST_ENV_SOURCE, NODE_ENV: 'staging' })).toContain('NODE_ENV');
  });

  it('parses FULFILLMENT_DRY_RUN strictly', () => {
    expect(buildTestEnv({ FULFILLMENT_DRY_RUN: 'false' }).FULFILLMENT_DRY_RUN).toBe(false);
    for (const bad of ['yes', '0', 'FALSE']) {
      expect(messageOf({ ...TEST_ENV_SOURCE, FULFILLMENT_DRY_RUN: bad })).toContain(
        'FULFILLMENT_DRY_RUN',
      );
    }
  });

  it('rejects an unknown TON_NETWORK', () => {
    expect(messageOf({ ...TEST_ENV_SOURCE, TON_NETWORK: 'devnet' })).toContain('TON_NETWORK');
  });

  it('parses money limits as BigInt without precision loss', () => {
    const env = buildTestEnv({
      TON_MAX_PER_ORDER_NANO: '9007199254740993', // 2^53 + 1
      TON_MAX_DAILY_NANO: '123456789012345678901234567890',
    });
    expect(env.TON_MAX_PER_ORDER_NANO).toBe(9007199254740993n);
    expect(env.TON_MAX_DAILY_NANO).toBe(123456789012345678901234567890n);
  });

  it('rejects limits that are not plain digit strings', () => {
    for (const name of [
      'TON_MAX_PER_ORDER_NANO',
      'TON_MAX_DAILY_NANO',
      'TON_MIN_BALANCE_ALERT_NANO',
      'SUPPLIER_MAX_PER_ORDER_MICRO_USDT',
    ]) {
      for (const bad of ['1.5', '-1', '1e9', '12abc', '0x10']) {
        expect(messageOf({ ...TEST_ENV_SOURCE, [name]: bad })).toContain(name);
      }
    }
  });

  describe('bank-feed settings', () => {
    const bots = { BANK_FEED_HUMO_BOT_ID: '111000111', BANK_FEED_UZCARD_BOT_ID: '222000222' };

    it('parses the pinned bot ids as BigInt and defaults the lock wait', () => {
      const env = buildTestEnv(bots);
      expect(env.BANK_FEED_HUMO_BOT_ID).toBe(111000111n);
      expect(env.BANK_FEED_UZCARD_BOT_ID).toBe(222000222n);
      expect(env.BANK_FEED_LOCK_TIMEOUT_MS).toBe(3_000);
      expect(buildTestEnv().BANK_FEED_HUMO_BOT_ID).toBeUndefined();
    });

    it.each(['-1', '0', '012', 'abc', '1.5', '1'.repeat(21)])('refuses the bot id %j', (bad) => {
      expect(messageOf({ ...TEST_ENV_SOURCE, BANK_FEED_HUMO_BOT_ID: bad })).toContain(
        'BANK_FEED_HUMO_BOT_ID',
      );
    });

    it.each(['99', '10001', 'x'])('refuses the lock wait %j', (bad) => {
      expect(messageOf({ ...TEST_ENV_SOURCE, BANK_FEED_LOCK_TIMEOUT_MS: bad })).toContain(
        'BANK_FEED_LOCK_TIMEOUT_MS',
      );
    });

    it('requires both bot ids in production', () => {
      const prod = { ...TEST_ENV_SOURCE, NODE_ENV: 'production', FULFILLMENT_DRY_RUN: 'true' };
      const message = messageOf(prod);
      expect(message).toContain('BANK_FEED_HUMO_BOT_ID: is required in production');
      expect(message).toContain('BANK_FEED_UZCARD_BOT_ID: is required in production');
      expect(() => loadEnv({ ...prod, ...bots })).not.toThrow();
    });

    // The owner alerts leave through the API (notify consumer): the worker has no use for it.
    it('does not declare OWNER_ALERT_CHAT_ID', () => {
      expect(buildTestEnv({ OWNER_ALERT_CHAT_ID: '555000' })).not.toHaveProperty(
        'OWNER_ALERT_CHAT_ID',
      );
    });
  });

  describe('API-only secrets', () => {
    it.each(API_ONLY_SECRETS)('refuses to boot when %s is set', (name) => {
      const message = messageOf({ ...TEST_ENV_SOURCE, [name]: SECRET_VALUE });
      expect(message).toContain(name);
      expect(message).toContain('API-only');
      expect(message).not.toContain(SECRET_VALUE);
    });

    it('refuses OTP_PEPPER explicitly (phase 2): only the API hashes login codes', () => {
      const message = messageOf({ ...TEST_ENV_SOURCE, OTP_PEPPER: SECRET_VALUE });
      expect(message).toContain(
        'OTP_PEPPER: API-only secret must not be set in the worker environment',
      );
      expect(message).not.toContain(SECRET_VALUE);
      expect(API_ONLY_SECRETS).toContain('OTP_PEPPER');
    });

    it('refuses in production too, and reports every offender at once', () => {
      const message = messageOf({
        ...TEST_ENV_SOURCE,
        NODE_ENV: 'production',
        FULFILLMENT_DRY_RUN: 'true',
        JWT_ACCESS_SECRET: SECRET_VALUE,
        PAYME_KEY: SECRET_VALUE,
      });
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('PAYME_KEY');
    });

    it('allows them to be empty (as in a copied API .env.example)', () => {
      const source = Object.fromEntries(API_ONLY_SECRETS.map((n) => [n, '']));
      expect(() => loadEnv({ ...TEST_ENV_SOURCE, ...source })).not.toThrow();
    });

    it('keeps its own template free of them', () => {
      const template = readFileSync(join(__dirname, '../../../.env.example'), 'utf8');
      for (const name of API_ONLY_SECRETS)
        expect(template).not.toMatch(new RegExp(`^${name}=`, 'm'));
    });
  });

  describe('secrets', () => {
    const prod = {
      ...TEST_ENV_SOURCE,
      NODE_ENV: 'production',
      FULFILLMENT_DRY_RUN: 'true',
      BANK_FEED_HUMO_BOT_ID: '111000111',
      BANK_FEED_UZCARD_BOT_ID: '222000222',
    };

    it('are optional, and empty values are treated as unset', () => {
      const source = Object.fromEntries(
        [...PRODUCTION_GENERATED_SECRETS, ...PRODUCTION_ISSUED_CREDENTIALS].map((n) => [n, '']),
      );
      expect(() => loadEnv({ ...prod, ...source })).not.toThrow();
    });

    it('requires FULFILLMENT_DRY_RUN to be explicit in production', () => {
      const { FULFILLMENT_DRY_RUN: _omit, ...withoutFlag } = prod;
      expect(messageOf(withoutFlag)).toContain('FULFILLMENT_DRY_RUN: is required but not set');
    });

    it.each([...PRODUCTION_GENERATED_SECRETS, ...PRODUCTION_ISSUED_CREDENTIALS])(
      'rejects a %s placeholder in production',
      (name) => {
        expect(messageOf({ ...prod, [name]: 'change-me-please' })).toContain(name);
        expect(messageOf({ ...prod, [name]: '<paste-here>' })).toContain(name);
      },
    );

    it('rejects short generated secrets but not short issued credentials', () => {
      const message = messageOf({ ...prod, WALLET_ENC_KEY: 'short', TON_API_KEY: 'short' });
      expect(message).toContain('WALLET_ENC_KEY');
      expect(message).not.toContain('TON_API_KEY');
    });

    it('accepts strong values in production', () => {
      expect(() => loadEnv({ ...prod, WALLET_ENC_KEY: LONG_SECRET })).not.toThrow();
    });

    it('allows placeholders outside production', () => {
      expect(() => buildTestEnv({ WALLET_ENC_KEY: 'change-me' })).not.toThrow();
    });

    it('never prints the offending value', () => {
      const message = messageOf({ ...prod, WALLET_ENC_KEY: SECRET_VALUE.slice(0, 20) });
      expect(message).toContain('WALLET_ENC_KEY');
      expect(message).not.toContain(SECRET_VALUE.slice(0, 20));
      const bad = messageOf({ ...TEST_ENV_SOURCE, DATABASE_URL: `mysql://u:${SECRET_VALUE}@h/d` });
      expect(bad).toContain('DATABASE_URL');
      expect(bad).not.toContain(SECRET_VALUE);
    });
  });
});

describe('loadProcessEnv (the real entry point)', () => {
  it('refuses NODE_ENV=test when not running under Jest, naming the variable', () => {
    expect(() => loadProcessEnv({ ...TEST_ENV_SOURCE })).toThrow(EnvValidationError);
    expect(() => loadProcessEnv({ ...TEST_ENV_SOURCE })).toThrow(
      /NODE_ENV: "test" is only for test runs/,
    );
  });

  it('accepts it under Jest, and loads other environments as loadEnv does', () => {
    expect(() => loadProcessEnv({ ...TEST_ENV_SOURCE, JEST_WORKER_ID: '1' })).not.toThrow();
    expect(() => loadProcessEnv({ ...TEST_ENV_SOURCE, NODE_ENV: 'development' })).not.toThrow();
  });
});
