import { EnvValidationError, loadEnv } from '../env';
import {
  TEST_BOT_TOKEN,
  TEST_ENV_SOURCE,
  TEST_JWT_ACCESS_SECRET,
  TEST_OTP_PEPPER,
  TEST_WEBHOOK_SECRET,
  buildTestEnv,
} from './test-env';

function messageOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('auth and bot settings (phase 2)', () => {
  const webhook = {
    ...TEST_ENV_SOURCE,
    TELEGRAM_BOT_MODE: 'webhook',
    TELEGRAM_WEBHOOK_URL: 'https://api.ggpin.uz/api/v1/telegram/webhook',
    TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  };

  it.each([
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'TG_SESSION_SECRET',
    'OTP_PEPPER',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_USERNAME',
  ])('requires %s, and treats an empty value as missing', (name) => {
    const { [name]: _removed, ...without } = TEST_ENV_SOURCE;
    expect(messageOf(without)).toContain(`${name}: is required but not set`);
    expect(messageOf({ ...TEST_ENV_SOURCE, [name]: '' })).toContain(
      `${name}: is required but not set`,
    );
  });

  describe('TELEGRAM_BOT_TOKEN', () => {
    it('accepts the BotFather format', () => {
      expect(buildTestEnv().TELEGRAM_BOT_TOKEN).toBe(TEST_BOT_TOKEN);
      const longId = ['1234567890', 'b'.repeat(33)].join(':');
      expect(() => buildTestEnv({ TELEGRAM_BOT_TOKEN: longId })).not.toThrow();
    });

    it.each([
      ['no colon', 'x'.repeat(40)],
      ['id too short', ['12345', 'a'.repeat(35)].join(':')],
      ['id too long', ['1'.repeat(13), 'a'.repeat(35)].join(':')],
      ['secret too short', ['123456789', 'a'.repeat(29)].join(':')],
      ['bad character', ['123456789', `${'a'.repeat(34)}!`].join(':')],
      ['non-numeric id', ['abcdef', 'a'.repeat(35)].join(':')],
    ])('rejects a malformed token (%s) without echoing it', (_label, value) => {
      const message = messageOf({ ...TEST_ENV_SOURCE, TELEGRAM_BOT_TOKEN: value });
      expect(message).toContain('TELEGRAM_BOT_TOKEN');
      expect(message).not.toContain(value);
    });
  });

  describe('TELEGRAM_BOT_USERNAME', () => {
    it.each(['ggpin_bot', 'GGPIN_BOT', 'GgPin_Test_Bot', 'abcBot', 'a1234bot'])(
      'accepts %s',
      (value) => {
        expect(buildTestEnv({ TELEGRAM_BOT_USERNAME: value }).TELEGRAM_BOT_USERNAME).toBe(value);
      },
    );

    it.each([
      'ggpin',
      '@ggpin_bot',
      'bot',
      'abot',
      'ggpin-bot',
      'ggpin bot',
      `${'a'.repeat(30)}bot`,
      'ggpin_bot_',
    ])('rejects %s', (value) => {
      expect(messageOf({ ...TEST_ENV_SOURCE, TELEGRAM_BOT_USERNAME: value })).toContain(
        'TELEGRAM_BOT_USERNAME',
      );
    });
  });

  describe('TELEGRAM_BOT_MODE', () => {
    it('accepts off, polling and webhook', () => {
      expect(buildTestEnv({ TELEGRAM_BOT_MODE: 'off' }).TELEGRAM_BOT_MODE).toBe('off');
      expect(buildTestEnv({ TELEGRAM_BOT_MODE: 'polling' }).TELEGRAM_BOT_MODE).toBe('polling');
      expect(loadEnv(webhook).TELEGRAM_BOT_MODE).toBe('webhook');
    });

    it('rejects anything else', () => {
      for (const bad of ['on', 'Polling', 'long-polling', 'true']) {
        expect(messageOf({ ...TEST_ENV_SOURCE, TELEGRAM_BOT_MODE: bad })).toContain(
          'TELEGRAM_BOT_MODE',
        );
      }
    });
  });

  describe('webhook mode', () => {
    it('requires the webhook URL and secret', () => {
      const { TELEGRAM_WEBHOOK_URL: _url, TELEGRAM_WEBHOOK_SECRET: _secret, ...bare } = webhook;
      const message = messageOf(bare);
      expect(message).toContain('TELEGRAM_WEBHOOK_URL: is required when TELEGRAM_BOT_MODE=webhook');
      expect(message).toContain(
        'TELEGRAM_WEBHOOK_SECRET: is required when TELEGRAM_BOT_MODE=webhook',
      );
    });

    it('does not need them in off or polling mode', () => {
      expect(() => buildTestEnv({ TELEGRAM_BOT_MODE: 'off' })).not.toThrow();
      expect(() => buildTestEnv({ TELEGRAM_BOT_MODE: 'polling' })).not.toThrow();
    });

    it('requires an https URL', () => {
      expect(messageOf({ ...webhook, TELEGRAM_WEBHOOK_URL: 'http://api.ggpin.uz/hook' })).toContain(
        'TELEGRAM_WEBHOOK_URL: must use https',
      );
    });

    it('accepts only Telegram secret_token characters, 32 to 256 long', () => {
      const bad = [
        'short',
        'a'.repeat(31),
        'a'.repeat(257),
        `${'a'.repeat(31)}!`,
        `${'a'.repeat(31)} `,
        `${'a'.repeat(31)}.`,
      ];
      for (const value of bad) {
        const message = messageOf({ ...webhook, TELEGRAM_WEBHOOK_SECRET: value });
        expect(message).toContain('TELEGRAM_WEBHOOK_SECRET');
        expect(message).not.toContain(value);
      }
      for (const value of ['a'.repeat(32), 'A1_-'.repeat(8), 'b'.repeat(256)]) {
        expect(() => loadEnv({ ...webhook, TELEGRAM_WEBHOOK_SECRET: value })).not.toThrow();
      }
    });

    it('validates the secret format in every mode when it is set', () => {
      expect(messageOf({ ...TEST_ENV_SOURCE, TELEGRAM_WEBHOOK_SECRET: 'short' })).toContain(
        'TELEGRAM_WEBHOOK_SECRET',
      );
    });
  });

  describe('TELEGRAM_NEWS_CHANNEL_URL', () => {
    it('is optional and accepts a t.me https link', () => {
      expect(
        buildTestEnv({ TELEGRAM_NEWS_CHANNEL_URL: 'https://t.me/ggpin_news' })
          .TELEGRAM_NEWS_CHANNEL_URL,
      ).toBe('https://t.me/ggpin_news');
    });

    it.each([
      'http://t.me/ggpin_news',
      'https://example.com/ggpin_news',
      'https://t.me.evil.test/x',
      'https://telegram.me/x',
      't.me/ggpin_news',
      'not a url',
    ])('rejects %s', (value) => {
      expect(messageOf({ ...TEST_ENV_SOURCE, TELEGRAM_NEWS_CHANNEL_URL: value })).toContain(
        'TELEGRAM_NEWS_CHANNEL_URL',
      );
    });
  });

  describe('distinct signing secrets', () => {
    const names = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TG_SESSION_SECRET', 'OTP_PEPPER'];

    it('refuses any two equal secrets, naming both variables but not the value', () => {
      for (const [i, a] of names.entries()) {
        for (const b of names.slice(i + 1)) {
          const shared = TEST_ENV_SOURCE[a] ?? '';
          const message = messageOf({ ...TEST_ENV_SOURCE, [b]: shared });
          expect(message).toContain(`${b}: must differ from ${a}`);
          expect(message).not.toContain(shared);
        }
      }
    });

    it('treats surrounding whitespace as no difference', () => {
      expect(
        messageOf({ ...TEST_ENV_SOURCE, OTP_PEPPER: ` ${TEST_JWT_ACCESS_SECRET} ` }),
      ).toContain('OTP_PEPPER: must differ from JWT_ACCESS_SECRET');
    });

    it('reports every pair when all four are equal', () => {
      const same = Object.fromEntries(names.map((n) => [n, TEST_OTP_PEPPER]));
      const message = messageOf({ ...TEST_ENV_SOURCE, ...same });
      expect(message.match(/must differ from/g)).toHaveLength(6);
    });

    it('applies outside production too, whatever the values look like', () => {
      expect(
        messageOf({
          ...TEST_ENV_SOURCE,
          NODE_ENV: 'development',
          JWT_REFRESH_SECRET: 'change-me',
          OTP_PEPPER: 'change-me',
        }),
      ).toContain('OTP_PEPPER: must differ from JWT_REFRESH_SECRET');
    });
  });
  describe('production', () => {
    const prod = {
      ...TEST_ENV_SOURCE,
      NODE_ENV: 'production',
      WEB_URL: 'https://ggpin.uz',
      ADMIN_URL: 'https://admin.ggpin.uz',
      MINI_APP_URL: 'https://ggpin.uz/tg',
      TELEGRAM_BOT_MODE: 'webhook',
      TELEGRAM_WEBHOOK_URL: 'https://api.ggpin.uz/api/v1/telegram/webhook',
      TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    };

    it('accepts the complete configuration', () => {
      expect(() => loadEnv(prod)).not.toThrow();
    });

    it('requires MINI_APP_URL, over https', () => {
      const { MINI_APP_URL: _removed, ...without } = prod;
      expect(messageOf(without)).toContain('MINI_APP_URL: is required in production');
      expect(messageOf({ ...prod, MINI_APP_URL: 'http://ggpin.uz/tg' })).toContain(
        'MINI_APP_URL: must use https in production',
      );
    });

    it('does not need MINI_APP_URL outside production', () => {
      expect(buildTestEnv().MINI_APP_URL).toBeUndefined();
    });

    it('requires TELEGRAM_BOT_MODE=webhook', () => {
      for (const mode of ['off', 'polling']) {
        expect(messageOf({ ...prod, TELEGRAM_BOT_MODE: mode })).toContain(
          'TELEGRAM_BOT_MODE: must be "webhook" in production',
        );
      }
      const { TELEGRAM_BOT_MODE: _removed, ...unset } = prod;
      expect(messageOf(unset)).toContain('TELEGRAM_BOT_MODE: must be "webhook" in production');
    });

    it('requires OTP_PEPPER to be strong, like the other generated secrets', () => {
      expect(messageOf({ ...prod, OTP_PEPPER: 'short' })).toContain(
        'OTP_PEPPER: is too short for production',
      );
      expect(messageOf({ ...prod, OTP_PEPPER: 'change-me-min-32-chars-change-me-1234' })).toContain(
        'OTP_PEPPER: is a placeholder',
      );
    });
  });
});
