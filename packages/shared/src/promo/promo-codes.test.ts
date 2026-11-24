import { describe, expect, it } from 'vitest';
import {
  BONUS_CODE_RANDOM_MIN_LENGTH,
  DISCOUNT_CODE_PATTERN,
  PROMO_CODE_ALPHABET,
  PROMO_CODE_MAX_LENGTH,
  PROMO_CODE_RAW_MAX_LENGTH,
  PROMO_CODE_MIN_LENGTH,
  PROMO_CODE_PATTERN,
  VANITY_CODE_MIN_LENGTH,
  isGeneratedCodeAlphabet,
  normalizePromoCode,
} from './promo-codes';

// Built from code points so no look-alike character is ever written literally in this file.
const cp = (...points: number[]): string => String.fromCodePoint(...points);
const CYR_O = cp(0x041e); // capital O
const CYR_ES = cp(0x0421); // capital S, looks like C
const CYR_SMALL_O = cp(0x043e); // small o
const CYR_ZE = cp(0x0417); // looks like 3, but is not
const EN_DASH = cp(0x2013);
const MINUS_SIGN = cp(0x2212);
const NBSP = cp(0x00a0);

describe('normalizePromoCode', () => {
  it('upper-cases what was typed in lower case', () => {
    expect(normalizePromoCode('gg5000')).toBe('GG5000');
    expect(normalizePromoCode('Gg5000')).toBe('GG5000');
  });

  it('drops spaces and dashes between groups', () => {
    expect(normalizePromoCode('GG-7KQ2-MXP4')).toBe('GG7KQ2MXP4');
    expect(normalizePromoCode('  gg 7kq2 mxp4  ')).toBe('GG7KQ2MXP4');
    expect(normalizePromoCode(`GG${EN_DASH}7KQ2${MINUS_SIGN}MXP4`)).toBe('GG7KQ2MXP4');
    expect(normalizePromoCode(`GG${NBSP}7KQ2\tMXP4\n`)).toBe('GG7KQ2MXP4');
  });

  it('drops invisible format characters (Unicode Cf) like separators', () => {
    const formats = {
      zeroWidthSpace: 0x200b,
      zeroWidthNonJoiner: 0x200c,
      zeroWidthJoiner: 0x200d,
      wordJoiner: 0x2060,
      softHyphen: 0x00ad,
      leftToRightMark: 0x200e,
      rightToLeftMark: 0x200f,
      rightToLeftOverride: 0x202e,
      byteOrderMark: 0xfeff,
    };
    for (const [name, point] of Object.entries(formats)) {
      expect(normalizePromoCode(`GG${cp(point)}5000`), name).toBe('GG5000');
      expect(normalizePromoCode(`${cp(point)}gg5000${cp(point)}`), name).toBe('GG5000');
    }
  });

  it('reads full-width characters as ASCII (NFKC)', () => {
    expect(normalizePromoCode(cp(0xff27, 0xff27, 0xff15, 0xff10, 0xff10, 0xff10))).toBe('GG5000');
  });

  it('maps Cyrillic look-alikes to Latin, in upper and lower case', () => {
    expect(normalizePromoCode(`${CYR_ES}${CYR_O}DE7`)).toBe('CODE7');
    expect(normalizePromoCode(`pr${CYR_SMALL_O}m${CYR_SMALL_O}`)).toBe('PROMO');
    const all = cp(0x0410, 0x0412, 0x0415, 0x041a, 0x041c, 0x041d, 0x041e, 0x0420, 0x0421, 0x0422);
    expect(normalizePromoCode(all + cp(0x0423, 0x0425))).toBe('ABEKMHOPCTYX');
  });

  it('two spellings of one code give the same canonical form', () => {
    const forms = ['GG5000', 'gg 5000', 'gg-5000', `${'g'.toUpperCase()}G${EN_DASH}5000`];
    expect(new Set(forms.map(normalizePromoCode))).toEqual(new Set(['GG5000']));
  });

  it('refuses what is not a code: other letters, symbols, wrong length', () => {
    expect(normalizePromoCode(`GG${CYR_ZE}000`)).toBeNull();
    expect(normalizePromoCode('GG5000!')).toBeNull();
    expect(normalizePromoCode('GG_5000')).toBeNull();
    expect(normalizePromoCode(`${cp(0x00c9)}CODE`)).toBeNull(); // accented E
    expect(normalizePromoCode('ABC')).toBeNull();
    expect(normalizePromoCode('A-B-C')).toBeNull();
    expect(normalizePromoCode('')).toBeNull();
    expect(normalizePromoCode('   ')).toBeNull();
    expect(normalizePromoCode('A'.repeat(PROMO_CODE_MAX_LENGTH + 1))).toBeNull();
  });

  it('accepts the length bounds exactly', () => {
    expect(normalizePromoCode('A'.repeat(PROMO_CODE_MIN_LENGTH))).toBe('AAAA');
    expect(normalizePromoCode('a'.repeat(PROMO_CODE_MAX_LENGTH))).toBe('A'.repeat(32));
  });

  it('refuses a huge input before any work, even if it would shrink to a code', () => {
    expect(normalizePromoCode(`${' '.repeat(61)}ABCD`)).toBeNull();
    expect(normalizePromoCode(`${' '.repeat(60)}ABCD`)).toBe('ABCD');
  });
});

describe('promo code constants', () => {
  it('the canonical pattern takes Latin capitals and digits, 4..32', () => {
    expect(PROMO_CODE_PATTERN.test('GG5000')).toBe(true);
    expect(PROMO_CODE_PATTERN.test('gg5000')).toBe(false);
    expect(PROMO_CODE_PATTERN.test('ABC')).toBe(false);
    expect(VANITY_CODE_MIN_LENGTH).toBe(6);
  });

  it('the generated-code alphabet is Crockford base32 without 0 and 1 (no I, L, O, U either)', () => {
    expect(PROMO_CODE_ALPHABET).toHaveLength(30);
    expect(new Set(PROMO_CODE_ALPHABET).size).toBe(30);
    for (const ambiguous of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(PROMO_CODE_ALPHABET).not.toContain(ambiguous);
    }
    expect(PROMO_CODE_PATTERN.test(PROMO_CODE_ALPHABET.slice(0, 32))).toBe(true);
  });

  it('isGeneratedCodeAlphabet tells a generated code from one with ambiguous characters', () => {
    expect(isGeneratedCodeAlphabet('GG7KQ2MX')).toBe(true);
    expect(isGeneratedCodeAlphabet('GG5000')).toBe(false);
    expect(isGeneratedCodeAlphabet('GG1KQ2')).toBe(false);
  });

  it('generated formats: a discount code is GG + 8 alphabet characters; a bonus code has 10+', () => {
    expect(DISCOUNT_CODE_PATTERN.test('GG7KQ2MXP4')).toBe(true);
    expect(isGeneratedCodeAlphabet('GG7KQ2MXP4')).toBe(true);
    expect(DISCOUNT_CODE_PATTERN.test('GG17KQ2MX')).toBe(false); // has 1, and 7 random characters
    expect(DISCOUNT_CODE_PATTERN.test('GG7KQ2MXP')).toBe(false);
    expect(DISCOUNT_CODE_PATTERN.test('GG7KQ2MXP4Z')).toBe(false);
    expect(DISCOUNT_CODE_PATTERN.test('XX7KQ2MXP4')).toBe(false);
    expect(normalizePromoCode('GG-7KQ2-MXP4')).toMatch(DISCOUNT_CODE_PATTERN);
    expect(BONUS_CODE_RANDOM_MIN_LENGTH).toBe(10);
    expect(PROMO_CODE_RAW_MAX_LENGTH).toBe(64);
  });
});
