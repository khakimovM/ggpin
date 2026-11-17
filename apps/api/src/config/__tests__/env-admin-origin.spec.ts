import { EnvValidationError, loadEnv } from '../env';
import { TEST_ENV_SOURCE, TEST_WEBHOOK_SECRET } from './test-env';

function messageOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  return '';
}

// S2-m1 / S2-2: in production the admin origin belongs to the admin panel alone.
describe('ADMIN_URL in production', () => {
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

  it('boots with its own subdomain of the brand domain', () => {
    expect(() => loadEnv(prod)).not.toThrow();
    expect(() => loadEnv({ ...prod, ADMIN_URL: 'https://panel.ggpin.uz' })).not.toThrow();
  });

  it('refuses ADMIN_URL on the store origin, naming the rule and never the URL', () => {
    const message = messageOf({ ...prod, ADMIN_URL: 'https://ggpin.uz' });
    expect(message).toContain('ADMIN_URL: must not share its origin with WEB_URL in production');
    expect(message).not.toContain('https://ggpin.uz');
  });

  it('refuses ADMIN_URL on the Mini App origin', () => {
    const message = messageOf({
      ...prod,
      MINI_APP_URL: 'https://app.ggpin.uz/tg',
      ADMIN_URL: 'https://app.ggpin.uz',
    });
    expect(message).toContain('ADMIN_URL: must not share its origin with MINI_APP_URL');
    expect(message).not.toContain('app.ggpin.uz');
  });

  it('refuses ADMIN_URL on the API origin (the webhook URL names it)', () => {
    const message = messageOf({ ...prod, ADMIN_URL: 'https://api.ggpin.uz' });
    expect(message).toContain(
      'ADMIN_URL: must not share its origin with the API (TELEGRAM_WEBHOOK_URL) in production',
    );
    expect(message).not.toContain('api.ggpin.uz');
  });

  it.each([
    ['another domain', 'https://admin.example.com'],
    ['a look-alike domain', 'https://admin.evilggpin.uz'],
    ['the brand domain itself on another port', 'https://ggpin.uz:8443'],
    ['the brand domain as a prefix', 'https://admin.ggpin.uz.example.com'],
  ])('refuses %s (not a subdomain of the brand domain)', (_name, adminUrl) => {
    const message = messageOf({ ...prod, ADMIN_URL: adminUrl });
    expect(message).toContain('ADMIN_URL: must be a subdomain of ggpin.uz in production');
    expect(message).not.toContain(adminUrl);
  });

  it('development and test do not check it (local origins are all localhost)', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const source = { ...TEST_ENV_SOURCE, NODE_ENV, ADMIN_URL: TEST_ENV_SOURCE['WEB_URL'] ?? '' };
      expect(() => loadEnv(source)).not.toThrow();
    }
  });
});
