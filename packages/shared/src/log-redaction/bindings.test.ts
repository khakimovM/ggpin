import { describe, expect, it } from 'vitest';
import { REDACTED, redactSerializedBindings } from './index';

// Pino prints a bigint binding as a bare integer literal, e.g. `,"amountTiyin":123...891`.
describe('redactSerializedBindings: integers beyond 2^53', () => {
  it('keeps every digit of a BigInt binding (as a decimal string)', () => {
    const out = redactSerializedBindings(',"amountTiyin":12345678901234567891,"userId":"u-1"');
    expect(out).toBe(',"amountTiyin":"12345678901234567891","userId":"u-1"');
  });

  it('handles negatives, nesting and arrays, and leaves safe numbers numeric', () => {
    const out = redactSerializedBindings(
      ',"delta":-9007199254740993,"n":{"big":[9007199254740993,42,1.5,1e3]},"ok":9007199254740991',
    );
    expect(out).toBe(
      ',"delta":"-9007199254740993","n":{"big":["9007199254740993",42,1.5,1000]},"ok":9007199254740991',
    );
  });

  it('does not touch digits inside strings, escapes included', () => {
    const out = redactSerializedBindings(
      ',"note":"id 12345678901234567891 \\" 99999999999999999999"',
    );
    expect(out).toBe(',"note":"id 12345678901234567891 \\" 99999999999999999999"');
  });

  it('still redacts secrets next to a big integer', () => {
    const out = redactSerializedBindings(',"apiKey":"x","amountTiyin":12345678901234567891');
    expect(out).toBe(`,"apiKey":"${REDACTED}","amountTiyin":"12345678901234567891"`);
  });

  it('drops a malformed fragment (a lone minus sign) instead of passing it through', () => {
    expect(redactSerializedBindings(',"a":-')).toBe('');
  });
});
