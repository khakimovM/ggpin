import { describe, expect, it } from 'vitest';
import {
  RAW_TON_ADDRESS_PATTERN,
  RawTonAddressSchema,
  TON_HASH_PATTERN,
  TonHashSchema,
} from './address-format';

const H = 'ab'.repeat(32);

describe('raw TON address: one spelling per account (audit M2, N6)', () => {
  it('accepts the base chain and the master chain, lowercase hex', () => {
    for (const ok of [`0:${H}`, `-1:${H}`, `0:${'0'.repeat(64)}`]) {
      expect(RawTonAddressSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('refuses the same workchain spelled another way: 00, 000, -0, +0, 01', () => {
    for (const bad of [`00:${H}`, `000:${H}`, `-0:${H}`, `+0:${H}`, `01:${H}`, `-01:${H}`]) {
      expect(RawTonAddressSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('refuses other workchains, other forms, wrong length, case, padding and look-alikes', () => {
    const bad = [
      '',
      `1:${H}`,
      `-2:${H}`,
      `1234:${H}`,
      `x:${H}`,
      `0:${H.slice(1)}`,
      `0:${H}a`,
      `0:${H.toUpperCase()}`,
      `0:${'g'.repeat(64)}`,
      ` 0:${H}`,
      `0:${H}\n`,
      'EQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq8Uk',
      'UQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq5jh',
    ];
    for (const value of bad) {
      expect(RAW_TON_ADDRESS_PATTERN.test(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('TON hash: 64 lowercase hex', () => {
  it('accepts a hash and refuses everything else', () => {
    expect(TonHashSchema.safeParse(H).success).toBe(true);
    for (const bad of ['', 'abc', H.toUpperCase(), `${H}a`, H.slice(1), 'g'.repeat(64), `${H}\n`]) {
      expect(TON_HASH_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
