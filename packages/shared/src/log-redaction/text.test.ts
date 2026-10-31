import { describe, expect, it } from 'vitest';
import { REDACTED, scrubSecretsInText } from './index';

// Assembled at runtime so no token-shaped literal sits in the source.
const FAKE_BOT_TOKEN = ['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'].join(':');

describe('scrubSecretsInText', () => {
  it('hides URL credentials for any scheme', () => {
    expect(scrubSecretsInText('postgresql://ggpin:p%40ss@db:5432/app')).toBe(
      `postgresql://${REDACTED}@db:5432/app`,
    );
    expect(scrubSecretsInText('redis://:pw@cache:6379 and https://user:pw@x.test/a')).toBe(
      `redis://${REDACTED}@cache:6379 and https://${REDACTED}@x.test/a`,
    );
  });

  it('keeps URLs without credentials', () => {
    expect(scrubSecretsInText('https://api.test/path?a=1@b')).toBe('https://api.test/path?a=1@b');
  });

  it('hides Telegram bot tokens, also inside API URLs', () => {
    expect(
      scrubSecretsInText(`failed https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage`),
    ).toBe(`failed https://api.telegram.org/bot${REDACTED}/sendMessage`);
    expect(scrubSecretsInText(`token ${FAKE_BOT_TOKEN}`)).toBe(`token ${REDACTED}`);
  });

  it('hides Bearer and Basic credentials', () => {
    expect(scrubSecretsInText('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      `Authorization: Basic ${REDACTED}`,
    );
  });

  it('hides sensitive query parameters only', () => {
    expect(scrubSecretsInText('/cb?token=abc123&page=2&sign=zzz')).toBe(
      `/cb?token=${REDACTED}&page=2&sign=${REDACTED}`,
    );
  });

  it('hides key=value secrets in free text and connection strings', () => {
    expect(scrubSecretsInText('retry with token=abc123')).toBe(`retry with token=${REDACTED}`);
    expect(scrubSecretsInText('password=hunter2 host=db')).toBe(`password=${REDACTED} host=db`);
    expect(scrubSecretsInText('host=db password=hunter2; user=app')).toBe(
      `host=db password=${REDACTED}; user=app`,
    );
  });

  it('leaves ordinary text alone', () => {
    const text = 'order 42 failed: INSUFFICIENT_BALANCE at 12:30';
    expect(scrubSecretsInText(text)).toBe(text);
  });
});

describe('scrubSecretsInText: quoted values', () => {
  it('hides quoted key=value pairs without leaving the value behind', () => {
    expect(scrubSecretsInText('password="x"')).toBe(`password=${REDACTED}`);
    expect(scrubSecretsInText(`token='abc'`)).toBe(`token=${REDACTED}`);
    expect(scrubSecretsInText('login password="my pass phrase" host=db')).toBe(
      `login password=${REDACTED} host=db`,
    );
  });

  it('fails closed on an unterminated quote', () => {
    const out = scrubSecretsInText('password="abc and more');
    expect(out).not.toContain('abc');
    expect(out).toBe(`password=${REDACTED}`);
  });

  it('keeps quoted values of harmless keys', () => {
    expect(scrubSecretsInText('mode="require" name=\'x\'')).toBe('mode="require" name=\'x\'');
  });

  it('hides an OTP-shaped code in a query string, not an error code', () => {
    expect(scrubSecretsInText('verify?nonce=n1&code=123456')).toBe(
      `verify?nonce=n1&code=${REDACTED}`,
    );
    expect(scrubSecretsInText('code="123456"')).toBe(`code=${REDACTED}`);
    expect(scrubSecretsInText('failed code=ETIMEDOUT status=500')).toBe(
      'failed code=ETIMEDOUT status=500',
    );
  });
});

describe('scrubSecretsInText: JSON inside a string', () => {
  it('redacts the value and keeps the key', () => {
    expect(scrubSecretsInText('{"apiKey":"abc","orderId":"o-1"}')).toBe(
      `{"apiKey":"${REDACTED}","orderId":"o-1"}`,
    );
    expect(scrubSecretsInText('body: {"user": {"password" : "p w", "n": 1}}')).toBe(
      `body: {"user": {"password" : "${REDACTED}", "n": 1}}`,
    );
  });

  it('redacts numbers, booleans and whole sub-trees under a sensitive key', () => {
    expect(scrubSecretsInText('{"otp":123456,"ok":true}')).toBe(`{"otp":"${REDACTED}","ok":true}`);
    expect(scrubSecretsInText('{"cookies":[{"name":"sid","value":"a]b"}],"x":1}')).toBe(
      `{"cookies":"${REDACTED}","x":1}`,
    );
    expect(scrubSecretsInText('{"seed":{"a":"}"},"y":2}')).toBe(`{"seed":"${REDACTED}","y":2}`);
  });

  it('handles escapes inside the value and keeps null', () => {
    expect(scrubSecretsInText('{"token":"a\\"b","z":1}')).toBe(`{"token":"${REDACTED}","z":1}`);
    expect(scrubSecretsInText('{"token":null,"z":1}')).toBe('{"token":null,"z":1}');
  });

  it('redacts an OTP-shaped code in a stringified verify body only', () => {
    expect(scrubSecretsInText('{"nonce":"n","code":"123456"}')).toBe(
      `{"nonce":"n","code":"${REDACTED}"}`,
    );
    expect(scrubSecretsInText('{"code":"INSUFFICIENT_BALANCE"}')).toBe(
      '{"code":"INSUFFICIENT_BALANCE"}',
    );
  });

  it('handles JSON that was stringified twice', () => {
    const inner = JSON.stringify({ apiKey: 'abc', id: 1 });
    const out = scrubSecretsInText(JSON.stringify({ msg: inner }));
    expect(out).not.toContain('abc');
    expect(out).toContain('apiKey');
    expect(out).toContain('"id\\":1');
  });

  it('fails closed on truncated JSON', () => {
    expect(scrubSecretsInText('{"apiKey":"abc')).toBe(`{"apiKey":"${REDACTED}"`);
    expect(scrubSecretsInText('{"cookies":[{"a":"b"')).toBe(`{"cookies":"${REDACTED}"`);
    expect(scrubSecretsInText('{\\"apiKey\\":\\"abc')).toBe(`{\\"apiKey\\":\\"${REDACTED}\\"`);
  });

  it('does not treat a string value that equals a key name as a field', () => {
    expect(scrubSecretsInText('["password","x"]')).toBe('["password","x"]');
  });
});

describe('scrubSecretsInText: phone numbers', () => {
  it.each([
    '+998901234567',
    '998901234567',
    '+998 90 123 45 67',
    '+998 (90) 123-45-67',
    '+998-90-123-45-67',
  ])('hides %s', (phone) => {
    expect(scrubSecretsInText(`call ${phone} now`)).toBe(`call ${REDACTED} now`);
  });

  it('leaves ordinary numbers, ids and dates alone', () => {
    const text =
      'order 42 amount 150000 tiyin 99890123456789 at 2026-10-31T10:00:00.000Z id 9981-2345 sslmode=require';
    expect(scrubSecretsInText(text)).toBe(text);
  });
});
