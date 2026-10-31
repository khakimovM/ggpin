import { describe, expect, it } from 'vitest';
import {
  MAX_REDACTION_DEPTH,
  REDACTED,
  redactChildBindings,
  redactLogRecord,
  redactSecrets,
  redactSerializedBindings,
} from './index';

// A representative subset; keys.test.ts covers every name the policy knows.
const SENSITIVE_KEYS = ['authorization', 'set-cookie', 'initData', 'apiKey', 'password', 'phone'];

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

  it('redacts `code` only when it looks like a one-time code', () => {
    // The OTP verify body is { nonce, code }.
    expect(redactSecrets({ nonce: 'n-1', code: '123456' })).toEqual({
      nonce: 'n-1',
      code: REDACTED,
    });
    expect(redactSecrets({ code: 4821 })).toEqual({ code: REDACTED });
    expect(redactSecrets({ code: '1234' })).toEqual({ code: REDACTED });
    expect(redactSecrets({ code: '12345678' })).toEqual({ code: REDACTED });
    for (const code of [-31050, 500, 'ETIMEDOUT', 'INSUFFICIENT_BALANCE', '123', '123456789']) {
      expect(redactSecrets({ code })).toEqual({ code });
    }
    expect(redactSecrets({ code: true, err: { code: 99001 } })).toEqual({
      code: true,
      err: { code: REDACTED },
    });
  });

  it('keeps useful non-secret identifiers', () => {
    const record = {
      idempotencyKey: 'k-1',
      txHash: '0xabc',
      orderId: 'o-1',
      provider: 'click',
      status: 'PAID',
      cacheKey: 'wallet:1',
      jobId: 'j-1',
      queue: 'fulfill-order',
    };
    expect(redactSecrets(record)).toEqual(record);
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

describe('redactSerializedBindings / redactChildBindings', () => {
  it('redacts values in a Pino bindings fragment and keeps the rest', () => {
    const fragment = `,"pid":7,"service":"api","apiKey":"abc","ctx":{"cookies":"c=1","id":2}`;
    expect(JSON.parse(`{${redactSerializedBindings(fragment).slice(1)}}`)).toEqual({
      pid: 7,
      service: 'api',
      apiKey: REDACTED,
      ctx: { cookies: REDACTED, id: 2 },
    });
  });

  it('accepts a fragment without the leading comma and returns empty for no bindings', () => {
    expect(redactSerializedBindings('"token":"t"')).toBe(`,"token":"${REDACTED}"`);
    expect(redactSerializedBindings('')).toBe('');
  });

  it('fails closed on text that is not a JSON fragment', () => {
    expect(redactSerializedBindings(',"apiKey":"abc')).toBe('');
  });

  it('rewrites the stored bindings of a child through the given symbol', () => {
    const sym = Symbol('chindings');
    const child = { [sym]: ',"apiKey":"abc","id":1' };
    redactChildBindings(child, sym);
    expect(child[sym]).toBe(`,"apiKey":"${REDACTED}","id":1`);
    const other = { [sym]: 42 };
    redactChildBindings(other, sym);
    expect(other[sym]).toBe(42);
  });
});
