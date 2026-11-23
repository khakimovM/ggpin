import { describe, expect, it } from 'vitest';
import { parseAmountInput } from '../amount-input';

const MAX = 100_000_000_000n;

describe('parseAmountInput (so‘m text → tiyin string)', () => {
  it.each([
    ['150 000', '15000000'],
    ['150 000', '15000000'],
    ['150 000', '15000000'],
    ['1500,5', '150050'],
    ['1500.05', '150005'],
    ['0,01', '1'],
  ])('%s → %s', (raw, tiyin) => {
    expect(parseAmountInput(raw, { maxTiyin: MAX })).toEqual({ ok: true, tiyin });
  });

  it('keeps the sign of a signed field: "-1 500,50" → "-150050"', () => {
    expect(parseAmountInput('-1 500,50', { signed: true, maxTiyin: MAX })).toEqual({
      ok: true,
      tiyin: '-150050',
    });
    expect(parseAmountInput('−1 500,50', { signed: true, maxTiyin: MAX })).toEqual({
      ok: true,
      tiyin: '-150050',
    });
  });

  it.each(['1.500', '1,500', '-1,500', '150 000,000', ',500'])(
    'refuses %s: three digits after the mark is ambiguous (CR-3)',
    (raw) => {
      expect(parseAmountInput(raw, { signed: true, maxTiyin: MAX })).toEqual({
        ok: false,
        issue: 'invalid',
      });
    },
  );

  it.each([
    ['1.5', '150'],
    ['1,50', '150'],
    ['1 500', '150000'],
    ['1500', '150000'],
    ['0,05', '5'],
  ])('one or two decimals still work: %s → %s', (raw, tiyin) => {
    expect(parseAmountInput(raw, { maxTiyin: MAX })).toEqual({ ok: true, tiyin });
  });

  it('refuses a minus where none is allowed', () => {
    expect(parseAmountInput('-10', { maxTiyin: MAX })).toEqual({ ok: false, issue: 'invalid' });
  });

  it('refuses three decimals, letters and two marks', () => {
    for (const raw of ['1,505', '12a', '1.2.3', '1,2,3']) {
      expect(parseAmountInput(raw, { maxTiyin: MAX }).ok).toBe(false);
    }
  });

  it('refuses zero and empty', () => {
    expect(parseAmountInput('0', { maxTiyin: MAX })).toEqual({ ok: false, issue: 'zero' });
    expect(parseAmountInput('0,00', { maxTiyin: MAX })).toEqual({ ok: false, issue: 'zero' });
    expect(parseAmountInput('  ', { maxTiyin: MAX })).toEqual({ ok: false, issue: 'empty' });
  });

  it('refuses more than the maximum, both signs, and accepts the maximum itself', () => {
    expect(parseAmountInput('1 000 000 000,01', { maxTiyin: MAX })).toEqual({
      ok: false,
      issue: 'tooLarge',
    });
    expect(parseAmountInput('-1000000000,01', { signed: true, maxTiyin: MAX })).toEqual({
      ok: false,
      issue: 'tooLarge',
    });
    expect(parseAmountInput('1000000000', { maxTiyin: MAX })).toEqual({
      ok: true,
      tiyin: '100000000000',
    });
  });

  it('is exact past Number precision (BigInt only)', () => {
    expect(parseAmountInput('90071992547409,93', { maxTiyin: 10n ** 20n })).toEqual({
      ok: true,
      tiyin: '9007199254740993',
    });
  });
});
