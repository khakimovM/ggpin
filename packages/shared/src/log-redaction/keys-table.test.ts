import { describe, expect, it } from 'vitest';
import { isSensitiveField, isSensitiveKey } from './index';

// Names the re-audit (RA-2) found unredacted, grouped by the rule that now catches them.
const MUST_REDACT = [
  // high-value stems anywhere in the key, plural or not
  'mnemonics',
  'mnemonicWords',
  'mnemonicArray',
  'seedPhraseWords',
  'privateKeys',
  'privateKeyPem',
  'secretKeys',
  'apiKeys',
  'passwords',
  'secrets',
  'credentials',
  'cookieJar',
  'sessionCookie',
  'passwd',
  'encryptionKey',
  'masterKey',
  'signingKey',
  'hmacKey',
  'sessionKey',
  'accessTokens',
  // phase 4: bank-feed session secrets and the pay-link capability token (D-39)
  'BANK_FEED_API_HASH',
  'BANK_FEED_SESSION_ENC',
  'BANK_FEED_ENC_KEY',
  'PAY_TOKEN_PEPPER',
  'x-pay-token',
  'X-Pay-Token',
  'payToken',
  'payTokenHash',
  'holderName',
  'holder_name',
  'bankText',
  'rawText',
  // exact names
  'pwd',
  'authHeader',
  'basicAuth',
  'fragmentHash',
  'pageHash',
  'stel_ssid',
  'stel_dt',
  'stel_token',
  'stel_ton_token',
  // UPPER_SNAKE names ending in _KEY
  'SUPPLIER_UNIPIN_KEY',
  'MOOGOLD_PARTNER_KEY',
  'FAZERCARDS_API_KEY',
  'ANYTHING_NEW_KEY',
];

// Deliberately logged: the allowlist wins over every secret rule.
const MUST_STAY_VISIBLE = [
  'idempotencyKey',
  'IDEMPOTENCY_KEY',
  'cacheKey',
  'CACHE_KEY',
  'lockKey',
  'publicKey',
  'jobKey',
  'queueKey',
  'txHash',
  'tokenId',
  'orderId',
  'provider',
  'status',
  'sequence',
  // camelCase *Key is not an env-style credential
  'sortKey',
  'primaryKey',
  'design',
  'tokenCount',
];

describe('key policy table', () => {
  it.each(MUST_REDACT)('redacts %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    expect(isSensitiveField(key, 'v')).toBe(true);
  });

  it.each(MUST_STAY_VISIBLE)('keeps %s visible', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('answers the same on repeated calls (memo) and survives a flood of distinct keys', () => {
    for (let i = 0; i < 5000; i += 1) expect(isSensitiveKey(`field${String(i)}`)).toBe(false);
    expect(isSensitiveKey('apiKeys')).toBe(true);
    expect(isSensitiveKey('apiKeys')).toBe(true);
    expect(isSensitiveKey('orderId')).toBe(false);
  });

  it('keeps Postgres SQLSTATEs under `code`, hides a six-digit one-time code', () => {
    for (const sqlstate of ['23505', '23514', '40001', '57014']) {
      expect(isSensitiveField('code', sqlstate)).toBe(false);
    }
    expect(isSensitiveField('code', '654321')).toBe(true);
  });
});
