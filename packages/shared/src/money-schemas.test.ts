import { describe, expect, it } from 'vitest';
import { SignedTiyinStringSchema, TiyinStringSchema } from './money-schemas';

describe('TiyinStringSchema', () => {
  it('accepts a non-negative integer string up to BIGINT max', () => {
    for (const ok of ['0', '1', '550000', '9223372036854775807']) {
      expect(TiyinStringSchema.safeParse(ok).success).toBe(true);
    }
  });

  it('rejects everything else with a validation error, never an exception', () => {
    // '20000.50' and '1e6' used to reach BigInt() and throw a SyntaxError (a 500 on a body).
    for (const bad of [
      '',
      '-1',
      '01',
      '20000.50',
      '1e6',
      ' 5',
      '5 ',
      '+5',
      'abc',
      '9223372036854775808',
      '0x10',
    ]) {
      const result = TiyinStringSchema.safeParse(bad);
      expect(result.success, bad).toBe(false);
    }
    expect(TiyinStringSchema.safeParse(5).success).toBe(false);
  });
});

describe('SignedTiyinStringSchema', () => {
  it('accepts signed integers within +-BIGINT max, without -0', () => {
    for (const ok of ['0', '-1', '1', '-9223372036854775807', '9223372036854775807']) {
      expect(SignedTiyinStringSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      '-0',
      '--1',
      '-',
      '+1',
      '1.5',
      '-1.5',
      '9223372036854775808',
      '-9223372036854775808',
    ]) {
      expect(SignedTiyinStringSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
