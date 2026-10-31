import { Readable } from 'node:stream';
import { toJsonSafe } from '../to-json-safe';

describe('toJsonSafe', () => {
  it('turns BigInt into strings at any depth, in objects and arrays', () => {
    const input = {
      balance: 9_007_199_254_740_993n,
      nested: { list: [1n, { deep: -5n }], keep: 'x' },
    };
    const out = toJsonSafe(input);
    expect(out).toEqual({
      balance: '9007199254740993',
      nested: { list: ['1', { deep: '-5' }], keep: 'x' },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('leaves primitives, null and undefined alone', () => {
    expect(toJsonSafe(null)).toBeNull();
    expect(toJsonSafe(undefined)).toBeUndefined();
    expect(toJsonSafe(7)).toBe(7);
    expect(toJsonSafe('a')).toBe('a');
  });

  it('keeps Date (serialised by its own toJSON), Buffers and streams as the same instance', () => {
    const date = new Date('2026-10-30T10:00:00.000Z');
    const buffer = Buffer.from('abc');
    const stream = Readable.from(['x']);
    const out = toJsonSafe({ date, buffer, stream, big: 1n }) as Record<string, unknown>;
    expect(out['date']).toBe(date);
    expect(out['buffer']).toBe(buffer);
    expect(out['stream']).toBe(stream);
    expect(out['big']).toBe('1');
    expect(JSON.stringify({ date: out['date'] })).toBe('{"date":"2026-10-30T10:00:00.000Z"}');
  });

  it('does not mutate its input', () => {
    const input = { a: 1n };
    toJsonSafe(input);
    expect(input.a).toBe(1n);
  });
});
