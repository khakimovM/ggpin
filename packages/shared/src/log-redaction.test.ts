import { describe, expect, it } from 'vitest';
import {
  MAX_REDACTION_DEPTH,
  REDACTED,
  isSensitiveKey,
  redactLogRecord,
  redactSecrets,
  scrubSecretsInText,
} from './log-redaction';

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

// Assembled at runtime so no token-shaped literal sits in the source.
const FAKE_BOT_TOKEN = ['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'].join(':');

describe('isSensitiveKey', () => {
  it.each(SENSITIVE_KEYS)('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['AUTHORIZATION', 'Set-Cookie', 'X-Api-Key', 'APIKEY', 'Init_Data', 'x-signature'])(
    'matches case and separator variants: %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  it.each(['code', 'message', 'status', 'orderId', 'design', 'tokenCount', 'txHash', 'userId'])(
    'does not flag %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('redactSecrets', () => {
  it.each(SENSITIVE_KEYS)('redacts %s at the top level', (key) => {
    const out = redactSecrets({ [key]: 'value-123', keep: 'visible' });
    expect(out).toEqual({ [key]: REDACTED, keep: 'visible' });
  });

  it('redacts case variants of the key', () => {
    expect(redactSecrets({ Authorization: 'Bearer abc', COOKIE: 'sid=1', ApiKey: 'k' })).toEqual({
      Authorization: REDACTED,
      COOKIE: REDACTED,
      ApiKey: REDACTED,
    });
  });

  it('redacts at any depth, including inside arrays', () => {
    const out = redactSecrets({
      payment: { provider: 'click', meta: { signature: 's3cr3t', amount: '100' } },
      items: [{ token: 't1', id: 1 }, { nested: [{ mnemonic: 'word word' }] }],
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret', accept: 'json' },
    });
    expect(out).toEqual({
      payment: { provider: 'click', meta: { signature: REDACTED, amount: '100' } },
      items: [{ token: REDACTED, id: 1 }, { nested: [{ mnemonic: REDACTED }] }],
      headers: { 'X-Telegram-Bot-Api-Secret-Token': REDACTED, accept: 'json' },
    });
  });

  it('redacts whole sub-trees under a sensitive key', () => {
    expect(redactSecrets({ cookies: [{ name: 'sid', value: 'abc' }] })).toEqual({
      cookies: REDACTED,
    });
  });

  it('keeps null and undefined under a sensitive key (nothing to protect)', () => {
    expect(redactSecrets({ token: null, secret: undefined })).toEqual({ token: null });
  });

  it('leaves the generic key `code` alone', () => {
    expect(redactSecrets({ code: 'INSUFFICIENT_BALANCE', err: { code: 'ECONNREFUSED' } })).toEqual({
      code: 'INSUFFICIENT_BALANCE',
      err: { code: 'ECONNREFUSED' },
    });
  });

  it('does not mutate its input', () => {
    const input = { a: { token: 'x', list: [{ password: 'p' }] }, b: 'ok' };
    const snapshot = structuredClone(input);
    const out = redactSecrets(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });

  it('passes primitives through and scrubs strings', () => {
    expect(redactSecrets(5)).toBe(5);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(10n)).toBe(10n);
    expect(redactSecrets('plain')).toBe('plain');
    expect(redactSecrets('Bearer abcdefgh12345')).toBe(`Bearer ${REDACTED}`);
  });

  it('drops functions and symbols like JSON does', () => {
    expect(redactSecrets({ fn: () => 1, sym: Symbol('x'), ok: 1 })).toEqual({ ok: 1 });
    expect(redactSecrets(() => 1)).toBeUndefined();
  });

  it('replaces cycles instead of recursing forever', () => {
    const a: Record<string, unknown> = { name: 'a', token: 't' };
    a.self = a;
    a.list = [a];
    expect(redactSecrets(a)).toEqual({
      name: 'a',
      token: REDACTED,
      self: '[Circular]',
      list: ['[Circular]'],
    });
  });

  it('does not call a shared (non-cyclic) reference a cycle', () => {
    const shared = { id: 1 };
    expect(redactSecrets({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it('truncates structures deeper than the limit', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 2; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain('[Truncated]');
  });

  it('keeps Dates, and turns binary data into a size marker', () => {
    const at = new Date('2026-10-31T10:00:00.000Z');
    expect(redactSecrets({ at, key: Buffer.from('super-secret-key') })).toEqual({
      at,
      key: '[Binary 16 bytes]',
    });
    expect(redactSecrets(new ArrayBuffer(4))).toBe('[Binary 4 bytes]');
  });

  it('handles Map and Set', () => {
    const out = redactSecrets({
      m: new Map<string, unknown>([
        ['token', 'x'],
        ['ok', 1],
      ]),
      s: new Set([{ password: 'p' }, 2]),
    });
    expect(out).toEqual({ m: { token: REDACTED, ok: 1 }, s: [{ password: REDACTED }, 2] });
  });

  it('serialises through toJSON and still scrubs the result', () => {
    const url = new URL('postgres://ggpin:hunter2@db:5432/ggpin');
    const out = redactSecrets({ url });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it('survives a throwing getter or toJSON', () => {
    const bad = {
      get boom(): string {
        throw new Error('nope');
      },
    };
    const badJson = {
      toJSON(): never {
        throw new Error('nope');
      },
    };
    expect(redactSecrets({ bad, badJson, ok: 1 })).toEqual({
      bad: '[Unserializable]',
      badJson: '[Unserializable]',
      ok: 1,
    });
  });

  it('copies a __proto__ own key as data instead of changing the prototype', () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"admin": true}, "ok": 1}');
    const out = redactSecrets(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'ok']);
    expect((out as { admin?: boolean }).admin).toBeUndefined();
  });

  describe('Errors', () => {
    it('keeps type, message and stack, redacts extra props and scrubs text', () => {
      class GatewayError extends Error {
        constructor(
          message: string,
          readonly code: string,
          readonly apiKey: string,
          readonly response: { headers: Record<string, string> },
        ) {
          super(message);
        }
      }
      const error = new GatewayError(
        'connect ECONNREFUSED redis://:hunter2@cache:6379',
        'ECONNREFUSED',
        'live-key-1',
        { headers: { authorization: 'Bearer abcdefgh1234', 'x-trace': 't' } },
      );
      const out = redactSecrets({ err: error }) as { err: Record<string, unknown> };
      expect(out.err.type).toBe('GatewayError');
      expect(out.err.code).toBe('ECONNREFUSED');
      expect(out.err.apiKey).toBe(REDACTED);
      expect(out.err.response).toEqual({ headers: { authorization: REDACTED, 'x-trace': 't' } });
      expect(out.err.message).toBe(`connect ECONNREFUSED redis://${REDACTED}@cache:6379`);
      expect(String(out.err.stack)).toContain('    at ');
      const wire = JSON.stringify(out);
      expect(wire).not.toContain('hunter2');
      expect(wire).not.toContain('live-key-1');
      expect(wire).not.toContain('abcdefgh1234');
    });

    it('follows cause and AggregateError members', () => {
      const root = new Error('root', { cause: { token: 'inner-token' } });
      const aggregate = new AggregateError([new Error('a'), { password: 'p' }], 'many', {
        cause: root,
      });
      const out = redactSecrets(aggregate) as Record<string, unknown>;
      const wire = JSON.stringify(out);
      expect(wire).not.toContain('inner-token');
      expect(wire).toContain('"message":"a"');
      expect((out.cause as Record<string, unknown>).type).toBe('Error');
      expect(out.errors).toHaveLength(2);
    });

    it('handles an error without a stack', () => {
      const error = new Error('no stack');
      error.stack = undefined;
      const out = redactSecrets(error) as Record<string, unknown>;
      expect(out).toEqual({ type: 'Error', message: 'no stack' });
    });
  });
});

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

describe('redactLogRecord', () => {
  it('redacts fields and leaves passthrough keys to their serializers', () => {
    const req = { token: 'kept-for-the-serializer' };
    const out = redactLogRecord(
      { req, payload: { password: 'p' }, token: 't', note: 'ok' },
      new Set(['req']),
    );
    expect(out).toEqual({
      req,
      payload: { password: REDACTED },
      token: REDACTED,
      note: 'ok',
    });
    expect(out.req).toBe(req);
  });

  it('works without passthrough keys and does not mutate the record', () => {
    const record = { a: { apiKey: 'k' } };
    const out = redactLogRecord(record);
    expect(out).toEqual({ a: { apiKey: REDACTED } });
    expect(record.a.apiKey).toBe('k');
  });

  it('copes with a record that references itself', () => {
    const record: Record<string, unknown> = { id: 1 };
    record.me = record;
    expect(redactLogRecord(record)).toEqual({ id: 1, me: '[Circular]' });
  });
});
