import { describe, expect, it } from 'vitest';
import { REDACTED, scrubSecretsInText } from './index';

describe('scrubSecretsInText: util.inspect / axios style', () => {
  it('hides unquoted-key and quoted-key JS object dumps', () => {
    expect(scrubSecretsInText("failed { apiKey: 'SEKRET1', userId: 'u1' }")).toBe(
      `failed { apiKey: '${REDACTED}', userId: 'u1' }`,
    );
    expect(scrubSecretsInText("{'token': 'SEKRET2', 'orderId': 'o-1'}")).toBe(
      `{'token': '${REDACTED}', 'orderId': 'o-1'}`,
    );
    expect(scrubSecretsInText('{ password: "p w", n: 1 }')).toBe(
      `{ password: "${REDACTED}", n: 1 }`,
    );
  });

  it('hides nested objects under a sensitive key and handles an apostrophe in a string', () => {
    expect(scrubSecretsInText("{ credentials: { user: 'a', pass: \"it's\" }, ok: true }")).toBe(
      `{ credentials: ${REDACTED}, ok: true }`,
    );
  });

  it('decides through the key policy, not a private list', () => {
    expect(scrubSecretsInText('{ mnemonicWords: ["a","b"], hmacKey: x1, SUPPLIER_X_KEY: y }')).toBe(
      `{ mnemonicWords: ${REDACTED}, hmacKey: ${REDACTED}, SUPPLIER_X_KEY: ${REDACTED} }`,
    );
    expect(scrubSecretsInText('{ idempotencyKey: k-1, txHash: 0xabc }')).toBe(
      '{ idempotencyKey: k-1, txHash: 0xabc }',
    );
  });
});

describe('scrubSecretsInText: unquoted key: value', () => {
  it('hides header-style lines', () => {
    expect(scrubSecretsInText('sent x-api-key: SEKRET3\nnext line')).toBe(
      `sent x-api-key: ${REDACTED}\nnext line`,
    );
    expect(scrubSecretsInText('Authorization: Paycom:dXNlcjpwYXNz')).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(scrubSecretsInText('Authorization: Bearer abc')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(scrubSecretsInText('Cookie: stel_ssid=abc; stel_token=def')).toBe(`Cookie: ${REDACTED}`);
  });

  it('hides a quoted digest value', () => {
    expect(scrubSecretsInText('row refreshTokenHash: "9f86d081884c7d65", id: 4')).toBe(
      `row refreshTokenHash: "${REDACTED}", id: 4`,
    );
  });

  it('hides a bare mnemonic to the end of the line', () => {
    const words = Array.from({ length: 24 }, (_, i) => `word${String(i)}`).join(' ');
    expect(scrubSecretsInText(`wallet mnemonic: ${words}\nnext`)).toBe(
      `wallet mnemonic: ${REDACTED}\nnext`,
    );
  });

  it('fails closed on a bare value longer than the scan bound', () => {
    const out = scrubSecretsInText(`token: ${'x'.repeat(5000)} tail`);
    expect(out).toBe(`token: ${REDACTED}`);
  });

  it('keeps the escape of a JSON-escaped quoted value under an unquoted key', () => {
    expect(scrubSecretsInText('log token: \\"abc\\" end')).toBe(`log token: \\"${REDACTED}\\" end`);
  });

  it('keeps ordinary colons: times, URLs, harmless keys, empty values', () => {
    const text = 'at 12:30:45 see https://api.test/x status: failed token: ';
    expect(scrubSecretsInText(text)).toBe(text);
  });

  it('hides a six-digit code but not an error code', () => {
    expect(scrubSecretsInText('verify { code: 123456 }')).toBe(`verify { code: ${REDACTED} }`);
    expect(scrubSecretsInText("{'code': '123456'}")).toBe(`{'code': '${REDACTED}'}`);
    expect(scrubSecretsInText('{ code: 23505, severity: ERROR }')).toBe(
      '{ code: 23505, severity: ERROR }',
    );
  });
});

describe('scrubSecretsInText: phone numbers in more shapes', () => {
  it.each(['+7 912 345 67 89', '+998 90 123-45-67', '+1 (415) 555-0132', '+44 20 7946 0958'])(
    'hides international %s',
    (phone) => {
      expect(scrubSecretsInText(`call ${phone} now`)).toBe(`call ${REDACTED} now`);
    },
  );

  it.each(['90 123 45 67', '90-123-45-67'])('hides the spaced local format %s', (phone) => {
    expect(scrubSecretsInText(`call ${phone} now`)).toBe(`call ${REDACTED} now`);
  });

  it('keeps bare 9-digit numbers and amounts (tiyin look like phone digits)', () => {
    const text = 'amount 901234567 and 500000000 tiyin, +150000, 10.123.45.67, 12 550 000 so‘m';
    expect(scrubSecretsInText(text)).toBe(text);
  });
});

describe('scrubSecretsInText: length cap', () => {
  it('scans a prefix and replaces the rest with [Truncated]', () => {
    const out = scrubSecretsInText(`token=abc ${'x'.repeat(100)} password=tail`, 20);
    expect(out).toBe(`token=${REDACTED} xxxxxxxxxx[Truncated]`);
    expect(out).not.toContain('tail');
  });

  it('leaves text up to the cap untouched', () => {
    expect(scrubSecretsInText('a'.repeat(20), 20)).toBe('a'.repeat(20));
  });
});
