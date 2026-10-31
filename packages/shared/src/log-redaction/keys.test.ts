import { describe, expect, it } from 'vitest';
import { isSensitiveField, isSensitiveKey } from './index';

// Every key the policy names (see docs/10-SECURITY.md and rules/60-security.md).
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-telegram-bot-api-secret-token',
  'initData',
  'hash',
  'signature',
  'sign',
  'sign_string',
  'mnemonic',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refresh_token',
  'otp',
  'otpCode',
  'verificationCode',
  'phone',
  'phoneNumber',
  'privateKey',
  'seed',
  'cookies',
];

// Real secret names and the camelCase forms they take in code (reviewer H1 / auditor H-1).
const SECRET_FORMS = [
  'WALLET_ENC_KEY',
  'TON_MNEMONIC_ENC',
  'FRAGMENT_SESSION_ENC_KEY',
  'TON_API_KEY',
  'RESELLER_STARS_API_KEY',
  'CLICK_SECRET_KEY',
  'PAYME_KEY',
  'UZUM_SECRET',
  'RAHMAT_SECRET',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'TG_SESSION_SECRET',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'secretKey',
  'encKey',
  'tokenHash',
  'codeHash',
  'passwordHash',
  'refreshTokenHash',
  'privKey',
  'seedPhrase',
  'seed_phrase',
  'walletSeedPhrase',
  'walletMnemonic',
  'sessionEncrypted_enc',
];

describe('isSensitiveKey', () => {
  it.each(SENSITIVE_KEYS)('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(SECRET_FORMS)('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['AUTHORIZATION', 'Set-Cookie', 'X-Api-Key', 'APIKEY', 'Init_Data', 'x-signature'])(
    'matches case and separator variants: %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  it.each([
    'code',
    'message',
    'status',
    'orderId',
    'design',
    'tokenCount',
    'txHash',
    'userId',
    'idempotencyKey',
    'cacheKey',
    'jobId',
    'queue',
    'provider',
    'sequence',
    'TON_NETWORK',
    'TON_MAX_PER_ORDER_NANO',
    'RESELLER_STARS_API_URL',
  ])('does not flag %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('isSensitiveField', () => {
  it('follows the key policy for any value', () => {
    expect(isSensitiveField('token', 'x')).toBe(true);
    expect(isSensitiveField('orderId', 'o-1')).toBe(false);
  });

  it('flags `code` only for OTP-shaped strings and numbers', () => {
    expect(isSensitiveField('code', '123456')).toBe(true);
    expect(isSensitiveField('Code', 1234)).toBe(true);
    expect(isSensitiveField('code', '123')).toBe(false);
    expect(isSensitiveField('code', '123456789')).toBe(false);
    expect(isSensitiveField('code', -31050)).toBe(false);
    expect(isSensitiveField('code', 'ETIMEDOUT')).toBe(false);
    expect(isSensitiveField('code', undefined)).toBe(false);
    expect(isSensitiveField('code', { a: 123456 })).toBe(false);
  });
});
