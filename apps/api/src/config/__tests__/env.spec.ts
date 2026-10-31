import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKER_ONLY_SECRETS } from '@repo/shared';
import { EnvValidationError, loadEnv } from '../env';
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

describe('loadEnv', () => {
  it('applies defaults for optional settings', () => {
    const env = buildTestEnv();
    expect(env).toMatchObject({
      API_PORT: 5000,
      LOG_LEVEL: 'info',
      TRUST_PROXY: [],
      SWAGGER_ENABLED: false,
      PAYME_TEST_MODE: true,
      TG_INITDATA_MAX_AGE_SEC: 86400,
      ADMIN_CONFIRM_THRESHOLD_TIYIN: 100000000n,
      TOPUP_MAX_TIYIN: 1000000000n,
    });
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([]);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(buildTestEnv())).toBe(true);
  });

  it('parses ports, booleans, origins and id lists', () => {
    const env = buildTestEnv({
      API_PORT: '5050',
      TRUST_PROXY: '10.0.0.0/8, ::1',
      SWAGGER_ENABLED: 'true',
      WEB_URL: 'https://ggpin.uz/',
      ADMIN_TELEGRAM_IDS: '123, 456',
    });
    expect(env.API_PORT).toBe(5050);
    expect(env.TRUST_PROXY).toEqual(['10.0.0.0/8', '::1']);
    expect(env.SWAGGER_ENABLED).toBe(true);
    expect(env.WEB_URL).toBe('https://ggpin.uz');
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([123n, 456n]);
  });

  it('treats an empty value as unset', () => {
    const env = buildTestEnv({ TELEGRAM_BOT_TOKEN: '', LOG_LEVEL: '' });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names every missing required variable at once', () => {
    const message = messageOf({ NODE_ENV: 'test' });
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'WEB_URL', 'ADMIN_URL']) {
      expect(message).toContain(`${name}: is required but not set`);
    }
  });

  it('rejects malformed values and names the variable', () => {
    expect(messageOf({ ...TEST_ENV_SOURCE, API_PORT: 'abc' })).toContain('API_PORT');
    expect(messageOf({ ...TEST_ENV_SOURCE, API_PORT: '70000' })).toContain('API_PORT');
    expect(messageOf({ ...TEST_ENV_SOURCE, NODE_ENV: 'staging' })).toContain('NODE_ENV');
    expect(messageOf({ ...TEST_ENV_SOURCE, WEB_URL: 'not a url' })).toContain('WEB_URL');
    expect(messageOf({ ...TEST_ENV_SOURCE, DATABASE_URL: 'mysql://x/y' })).toContain(
      'DATABASE_URL',
    );
    expect(messageOf({ ...TEST_ENV_SOURCE, REDIS_URL: 'http://x' })).toContain('REDIS_URL');
  });

  it('takes TRUST_PROXY as an allowlist of proxy IPs/CIDRs and refuses "trust everything"', () => {
    expect(buildTestEnv({ TRUST_PROXY: '127.0.0.1,::1, 172.18.0.0/16' }).TRUST_PROXY).toEqual([
      '127.0.0.1',
      '::1',
      '172.18.0.0/16',
    ]);
    for (const bad of ['true', 'false', '*', '1', '0', '2', '0.0.0.0/0', '::/0', '10.0.0.0/33']) {
      expect(messageOf({ ...TEST_ENV_SOURCE, TRUST_PROXY: bad })).toContain('TRUST_PROXY');
    }
  });

  it('parses booleans strictly', () => {
    for (const bad of ['yes', '1', 'TRUE', 'True']) {
      expect(messageOf({ ...TEST_ENV_SOURCE, SWAGGER_ENABLED: bad })).toContain('SWAGGER_ENABLED');
    }
  });

  it('parses money limits as BigInt and rejects non-digit strings', () => {
    const big = '9007199254740993'; // 2^53 + 1: not representable as a Number
    expect(buildTestEnv({ TOPUP_MAX_TIYIN: big }).TOPUP_MAX_TIYIN).toBe(9007199254740993n);
    for (const bad of ['1.5', '-1', '1e9', '12abc', '0x10']) {
      expect(messageOf({ ...TEST_ENV_SOURCE, TOPUP_MIN_TIYIN: bad })).toContain('TOPUP_MIN_TIYIN');
    }
  });

  describe('worker-only secrets', () => {
    it.each(WORKER_ONLY_SECRETS)('refuses to boot when %s is set', (name) => {
      const message = messageOf({ ...TEST_ENV_SOURCE, [name]: SECRET_VALUE });
      expect(message).toContain(name);
      expect(message).toContain('worker-only');
      expect(message).not.toContain(SECRET_VALUE);
    });

    it('allows them to be empty (as in a copied .env.example)', () => {
      const source = Object.fromEntries(WORKER_ONLY_SECRETS.map((n) => [n, '']));
      expect(() => loadEnv({ ...TEST_ENV_SOURCE, ...source })).not.toThrow();
    });

    it('does not reject harmless worker config such as TON_NETWORK', () => {
      expect(() => loadEnv({ ...TEST_ENV_SOURCE, TON_NETWORK: 'testnet' })).not.toThrow();
    });

    it.each([
      'SUPPLIER_PUBG_API_KEY',
      'SUPPLIER_STEAM_SECRET',
      'TON_WALLET_PRIVATE_KEY',
      'FRAGMENT_COOKIES',
      'TON_MNEMONIC',
      'SOMETHING_MNEMONIC',
      'MY_PRIVATE_KEY',
      'APP_SEED_PHRASE',
      'SESSION_COOKIE',
    ])('refuses worker-shaped secrets that are not on the exact list: %s', (name) => {
      const message = messageOf({ ...TEST_ENV_SOURCE, [name]: SECRET_VALUE });
      expect(message).toContain(name);
      expect(message).not.toContain(SECRET_VALUE);
    });

    // The worker's own template is the realistic source of names: secret-shaped ones must be
    // refused by the API, the rest (limits, URLs, network) must not be.
    describe('against apps/worker/.env.example', () => {
      const names = readFileSync(join(__dirname, '../../../../worker/.env.example'), 'utf8')
        .split(/\r?\n/)
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);
      const secretShaped = /SECRET|TOKEN|PASSWORD|MNEMONIC|COOKIE|PRIVATE|_KEY|_ENC/;
      const secrets = names.filter((n) => secretShaped.test(n));
      const harmless = names.filter((n) => !secretShaped.test(n));

      it('reads the template', () => {
        expect(secrets.length).toBeGreaterThanOrEqual(5);
        expect(harmless).toContain('TON_NETWORK');
      });

      it.each(secrets)('refuses %s', (name) => {
        expect(messageOf({ ...TEST_ENV_SOURCE, [name]: SECRET_VALUE })).toContain(name);
      });

      it('accepts the harmless worker settings', () => {
        const source = {
          ...TEST_ENV_SOURCE,
          TON_NETWORK: 'testnet',
          TON_API_ENDPOINT: 'https://toncenter.test/api',
          TON_MAX_PER_ORDER_NANO: '50000000000',
          TON_MAX_DAILY_NANO: '500000000000',
          TON_MIN_BALANCE_ALERT_NANO: '100000000000',
          RESELLER_STARS_API_URL: 'https://reseller.test',
          SUPPLIER_MAX_PER_ORDER_MICRO_USDT: '200000000',
          PRICE_TOLERANCE_BPS: '300',
          FULFILLMENT_DRY_RUN: 'true',
        };
        expect(() => loadEnv(source)).not.toThrow();
      });
    });
  });

  describe('production placeholder secrets', () => {
    const prod = {
      ...TEST_ENV_SOURCE,
      NODE_ENV: 'production',
      WEB_URL: 'https://ggpin.uz',
      ADMIN_URL: 'https://admin.ggpin.uz',
    };

    it('accepts a strong configuration', () => {
      expect(() =>
        loadEnv({ ...prod, JWT_ACCESS_SECRET: LONG_SECRET, TELEGRAM_BOT_TOKEN: '123456:abc' }),
      ).not.toThrow();
    });

    it('rejects change-me and <...> placeholders', () => {
      const message = messageOf({
        ...prod,
        JWT_ACCESS_SECRET: 'change-me-min-32-chars-change-me-min-32',
        JWT_REFRESH_SECRET: '<generate-a-long-random-secret-value>',
        TELEGRAM_BOT_TOKEN: '<bot token from BotFather>',
      });
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('JWT_REFRESH_SECRET');
      expect(message).toContain('TELEGRAM_BOT_TOKEN');
    });

    it('rejects short self-generated secrets but not short provider credentials', () => {
      const message = messageOf({ ...prod, TG_SESSION_SECRET: 'short', CLICK_SECRET_KEY: 'short' });
      expect(message).toContain('TG_SESSION_SECRET');
      expect(message).not.toContain('CLICK_SECRET_KEY');
    });

    it('allows the same placeholders outside production', () => {
      expect(() =>
        loadEnv({ ...TEST_ENV_SOURCE, NODE_ENV: 'development', JWT_ACCESS_SECRET: 'change-me' }),
      ).not.toThrow();
    });

    it('refuses SWAGGER_ENABLED=true in production, but not elsewhere', () => {
      const message = messageOf({ ...prod, SWAGGER_ENABLED: 'true' });
      expect(message).toContain('SWAGGER_ENABLED');
      expect(message).toContain('production');
      expect(() => loadEnv({ ...prod, SWAGGER_ENABLED: 'false' })).not.toThrow();
      expect(() => loadEnv({ ...TEST_ENV_SOURCE, SWAGGER_ENABLED: 'true' })).not.toThrow();
    });

    it('requires https origins', () => {
      expect(messageOf({ ...prod, WEB_URL: 'http://ggpin.uz' })).toContain('WEB_URL');
    });

    it('never prints the offending value', () => {
      const message = messageOf({ ...prod, JWT_ACCESS_SECRET: SECRET_VALUE.slice(0, 20) });
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).not.toContain(SECRET_VALUE.slice(0, 20));
    });
  });

  it('never prints values of invalid variables', () => {
    const message = messageOf({
      ...TEST_ENV_SOURCE,
      DATABASE_URL: `mysql://u:${SECRET_VALUE}@h/d`,
    });
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(SECRET_VALUE);
  });
});
