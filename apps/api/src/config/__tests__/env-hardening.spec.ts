import { EnvValidationError, loadEnv, loadProcessEnv } from '../env';
import { TEST_ENV_SOURCE, TEST_WEBHOOK_SECRET } from './test-env';

function messageOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

const SIGNING = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'TG_SESSION_SECRET',
  'OTP_PEPPER',
] as const;

describe('NODE_ENV is required', () => {
  it('has no default: a missing NODE_ENV stops the boot, naming the variable', () => {
    const { NODE_ENV: _removed, ...without } = TEST_ENV_SOURCE;
    expect(messageOf(without)).toContain('NODE_ENV: is required but not set');
  });

  it('rejects an unknown value', () => {
    expect(messageOf({ ...TEST_ENV_SOURCE, NODE_ENV: 'staging' })).toContain('NODE_ENV');
  });
});

describe('NODE_ENV=development with a webhook', () => {
  const dev = {
    ...TEST_ENV_SOURCE,
    NODE_ENV: 'development',
    TELEGRAM_BOT_MODE: 'webhook',
    TELEGRAM_WEBHOOK_URL: 'https://dev.example.test/api/v1/telegram/webhook',
    TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    OWNER_ALERT_CHAT_ID: '555000',
  };

  it('refuses to boot', () => {
    expect(messageOf(dev)).toContain('TELEGRAM_BOT_MODE: "webhook" is not allowed');
  });

  it('polling and off are fine in development, webhook is fine in test', () => {
    expect(() => loadEnv({ ...dev, TELEGRAM_BOT_MODE: 'polling' })).not.toThrow();
    expect(() => loadEnv({ ...dev, TELEGRAM_BOT_MODE: 'off' })).not.toThrow();
    expect(() => loadEnv({ ...dev, NODE_ENV: 'test' })).not.toThrow();
  });
});

describe('placeholder secrets', () => {
  const names = [...SIGNING, 'TELEGRAM_WEBHOOK_SECRET'] as const;

  it.each(names)('%s: a change-me placeholder is rejected in development', (name) => {
    const message = messageOf({
      ...TEST_ENV_SOURCE,
      NODE_ENV: 'development',
      [name]: 'change-me-x',
    });
    expect(message).toContain(`${name}: is a placeholder`);
    expect(message).not.toContain('change-me-x');
  });

  it.each(names)('%s: a <...> placeholder and an embedded change-me are rejected', (name) => {
    const dev = { ...TEST_ENV_SOURCE, NODE_ENV: 'development' };
    expect(messageOf({ ...dev, [name]: '<put-a-secret-here>' })).toContain(
      `${name}: is a placeholder`,
    );
    expect(messageOf({ ...dev, [name]: 'prefix-CHANGE-ME-suffix-1234567890' })).toContain(
      `${name}: is a placeholder`,
    );
  });

  it.each(names)('%s: a placeholder is rejected under NODE_ENV=test too (no bypass)', (name) => {
    const message = messageOf({ ...TEST_ENV_SOURCE, NODE_ENV: 'test', [name]: 'change-me-pepper' });
    expect(message).toContain(`${name}: is a placeholder`);
    expect(message).not.toContain('change-me-pepper');
  });

  it('the shared test fixtures are not placeholders', () => {
    expect(() => loadEnv({ ...TEST_ENV_SOURCE })).not.toThrow();
  });

  it('leaves provider credentials alone', () => {
    expect(() =>
      loadEnv({ ...TEST_ENV_SOURCE, NODE_ENV: 'development', CLICK_SECRET_KEY: 'change-me' }),
    ).not.toThrow();
  });
});

describe('production extras', () => {
  const prod = {
    ...TEST_ENV_SOURCE,
    NODE_ENV: 'production',
    TRUST_PROXY: '127.0.0.1',
    WEB_URL: 'https://ggpin.uz',
    ADMIN_URL: 'https://admin.ggpin.uz',
    MINI_APP_URL: 'https://ggpin.uz/tg',
    TELEGRAM_BOT_MODE: 'webhook',
    TELEGRAM_WEBHOOK_URL: 'https://api.ggpin.uz/api/v1/telegram/webhook',
    TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    OWNER_ALERT_CHAT_ID: '555000',
  };

  it('requires a non-empty TRUST_PROXY', () => {
    const { TRUST_PROXY: _removed, ...without } = prod;
    expect(messageOf(without)).toContain('TRUST_PROXY: is required in production');
    expect(messageOf({ ...prod, TRUST_PROXY: '   ' })).toContain('TRUST_PROXY: is required');
    // Non-blank text that parses to an empty list trusts nobody, so it is not "set" either.
    for (const empty of [',', ' , , ', ',,,']) {
      expect(messageOf({ ...prod, TRUST_PROXY: empty })).toContain('TRUST_PROXY: is required');
    }
    expect(() => loadEnv(prod)).not.toThrow();
  });

  it('does not need TRUST_PROXY outside production', () => {
    expect(() => loadEnv(TEST_ENV_SOURCE)).not.toThrow();
  });

  it('reports a placeholder once, not twice', () => {
    const message = messageOf({ ...prod, OTP_PEPPER: 'change-me-pepper-pepper-pepper-123456' });
    expect(message.match(/OTP_PEPPER:/g)).toHaveLength(1);
  });
});

describe('TELEGRAM_WEBHOOK_SECRET must differ from the signing secrets', () => {
  it('rejects a webhook secret equal to a signing secret', () => {
    const shared = TEST_ENV_SOURCE['OTP_PEPPER'] ?? '';
    const message = messageOf({
      ...TEST_ENV_SOURCE,
      TELEGRAM_WEBHOOK_SECRET: shared,
    });
    expect(message).toContain('TELEGRAM_WEBHOOK_SECRET: must differ from OTP_PEPPER');
  });

  it('accepts a distinct one', () => {
    expect(() =>
      loadEnv({ ...TEST_ENV_SOURCE, TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET }),
    ).not.toThrow();
  });
});

describe('PRICE_TOLERANCE_BPS', () => {
  it('defaults to 300 and accepts the whole 0..10000 range', () => {
    expect(loadEnv({ ...TEST_ENV_SOURCE }).PRICE_TOLERANCE_BPS).toBe(300);
    expect(loadEnv({ ...TEST_ENV_SOURCE, PRICE_TOLERANCE_BPS: '0' }).PRICE_TOLERANCE_BPS).toBe(0);
    expect(loadEnv({ ...TEST_ENV_SOURCE, PRICE_TOLERANCE_BPS: '10000' }).PRICE_TOLERANCE_BPS).toBe(
      10_000,
    );
  });

  it.each(['-1', '10001', '2.5', 'abc'])('rejects %s and names the variable', (bad) => {
    expect(messageOf({ ...TEST_ENV_SOURCE, PRICE_TOLERANCE_BPS: bad })).toContain(
      'PRICE_TOLERANCE_BPS',
    );
  });

  it('treats an empty line as unset', () => {
    expect(loadEnv({ ...TEST_ENV_SOURCE, PRICE_TOLERANCE_BPS: '' }).PRICE_TOLERANCE_BPS).toBe(300);
  });
});

describe('TG_INITDATA_MAX_AGE_SEC', () => {
  it('accepts up to 24 hours and rejects more', () => {
    expect(() => loadEnv({ ...TEST_ENV_SOURCE, TG_INITDATA_MAX_AGE_SEC: '86400' })).not.toThrow();
    expect(() => loadEnv({ ...TEST_ENV_SOURCE, TG_INITDATA_MAX_AGE_SEC: '3600' })).not.toThrow();
    expect(messageOf({ ...TEST_ENV_SOURCE, TG_INITDATA_MAX_AGE_SEC: '86401' })).toContain(
      'TG_INITDATA_MAX_AGE_SEC',
    );
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

describe('PRICING_ALLOW_SIMULATED', () => {
  const prod = {
    ...TEST_ENV_SOURCE,
    NODE_ENV: 'production',
    TRUST_PROXY: '127.0.0.1',
    WEB_URL: 'https://ggpin.uz',
    ADMIN_URL: 'https://admin.ggpin.uz',
    MINI_APP_URL: 'https://ggpin.uz/tg',
    TELEGRAM_BOT_MODE: 'webhook',
    TELEGRAM_WEBHOOK_URL: 'https://api.ggpin.uz/api/v1/telegram/webhook',
    TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    OWNER_ALERT_CHAT_ID: '555000',
  };

  it('is off by default, also when the line is empty', () => {
    expect(loadEnv({ ...TEST_ENV_SOURCE }).PRICING_ALLOW_SIMULATED).toBe(false);
    expect(
      loadEnv({ ...TEST_ENV_SOURCE, PRICING_ALLOW_SIMULATED: '' }).PRICING_ALLOW_SIMULATED,
    ).toBe(false);
  });

  it('is accepted as true or false outside production', () => {
    for (const nodeEnv of ['development', 'test']) {
      const source = { ...TEST_ENV_SOURCE, NODE_ENV: nodeEnv };
      expect(loadEnv({ ...source, PRICING_ALLOW_SIMULATED: 'true' }).PRICING_ALLOW_SIMULATED).toBe(
        true,
      );
      expect(loadEnv({ ...source, PRICING_ALLOW_SIMULATED: 'false' }).PRICING_ALLOW_SIMULATED).toBe(
        false,
      );
    }
  });

  it.each(['yes', '1', 'TRUE', 'True', 'on'])('rejects %s and names the variable', (bad) => {
    expect(messageOf({ ...TEST_ENV_SOURCE, PRICING_ALLOW_SIMULATED: bad })).toContain(
      'PRICING_ALLOW_SIMULATED',
    );
  });

  it('is refused in production, and the message does not blame anything else', () => {
    const message = messageOf({ ...prod, PRICING_ALLOW_SIMULATED: 'true' });
    expect(message).toContain('PRICING_ALLOW_SIMULATED: must not be "true" in production');
    expect(message).toContain('1 problem');
  });

  it('production is fine with it false or unset', () => {
    expect(loadEnv({ ...prod, PRICING_ALLOW_SIMULATED: 'false' }).PRICING_ALLOW_SIMULATED).toBe(
      false,
    );
    expect(loadEnv(prod).PRICING_ALLOW_SIMULATED).toBe(false);
  });
});
