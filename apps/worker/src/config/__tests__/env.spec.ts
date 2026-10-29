import { EnvValidationError, loadEnv } from '../env';
import { PRODUCTION_GENERATED_SECRETS, PRODUCTION_ISSUED_CREDENTIALS } from '../env-security';
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

  describe('secrets', () => {
    const prod = { ...TEST_ENV_SOURCE, NODE_ENV: 'production', FULFILLMENT_DRY_RUN: 'true' };

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
