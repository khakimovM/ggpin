import { describe, expect, it } from 'vitest';
import {
  compactSom,
  formatBps,
  formatCost,
  formatDate,
  formatDateTime,
  formatMinor,
  formatShortDate,
  formatSignedTiyin,
  formatTime,
  formatTiyin,
  maxTiyin,
  ratioOf,
  sameTashkentDay,
  shortHash,
} from '../format';

const NNBSP = '\u202F';

describe('admin money display', () => {
  it('formats tiyin strings through formatMoney, never as floats', () => {
    expect(formatTiyin('12550000')).toBe(`125${NNBSP}500`);
    // Beyond Number precision: the BigInt path keeps every digit.
    expect(formatTiyin('900719925474099300')).toBe(
      `9${NNBSP}007${NNBSP}199${NNBSP}254${NNBSP}740${NNBSP}993`,
    );
    expect(formatSignedTiyin('5000000')).toBe(`+50${NNBSP}000`);
    expect(formatSignedTiyin('-11000000')).toBe(`\u2212110${NNBSP}000`);
    expect(formatSignedTiyin('0')).toBe('0');
  });

  it('formats TON and USDT minor units without rounding', () => {
    expect(formatMinor('TON', '182400000000')).toBe('182,4');
    expect(formatMinor('USDT', '1240000000')).toBe(`1${NNBSP}240`);
    expect(formatMinor('TON', '1', 2)).toBe('0,000000001');
    expect(formatCost('TON', '3420000000')).toBe('3,42 TON');
    expect(formatCost('XYZ', '5')).toBe('5 XYZ');
  });

  it('turns amounts into chart ratios in BigInt basis points', () => {
    expect(ratioOf('2500', '10000')).toBe(0.25);
    expect(ratioOf('1', '3')).toBe(0.3333);
    expect(ratioOf('5', '0')).toBe(0);
    expect(ratioOf('-5', '10')).toBe(0);
    expect(maxTiyin(['5', '900719925474099300', '7'])).toBe(900719925474099300n);
  });

  it('writes axis labels in mln / ming', () => {
    expect(compactSom(500_000_000n)).toEqual({ value: '5', unit: 'mln' });
    expect(compactSom(250_000_000n)).toEqual({ value: '2,5', unit: 'mln' });
    expect(compactSom(1_500_000n)).toEqual({ value: '15', unit: 'ming' });
    expect(compactSom(50_000n)).toEqual({ value: '500', unit: 'none' });
  });

  it('shortens hashes for tables', () => {
    expect(shortHash('7cc09a1b2e3f11be')).toBe('7cc0…11be');
    expect(shortHash('abcd')).toBe('abcd');
  });

  it('writes dates in Tashkent time as the design does: "dd.mm.yyyy hh:mm" (R-10)', () => {
    // 09:02 UTC is 14:02 in Tashkent (UTC+5, no DST).
    expect(formatDateTime('2026-11-17T09:02:11Z')).toBe('17.11.2026 14:02');
    expect(formatDate('2026-11-17T09:02:11Z')).toBe('17.11.2026');
    expect(formatTime('2026-11-17T09:02:11Z')).toBe('14:02:11');
    expect(formatShortDate('2026-11-17T09:02:11Z')).toBe('17.11');
    // Midnight is 00, never 24; a UTC evening is already the next Tashkent day.
    expect(formatDateTime('2026-11-16T19:00:00Z')).toBe('17.11.2026 00:00');
    expect(formatDateTime('2026-01-05T03:07:00Z')).toBe('05.01.2026 08:07');
    expect(sameTashkentDay('2026-11-16T19:00:00Z', '2026-11-17T18:59:00Z')).toBe(true);
    expect(sameTashkentDay('2026-11-16T18:59:00Z', '2026-11-17T09:00:00Z')).toBe(false);
  });

  it('writes percents with a decimal comma and one digit at most (R-10)', () => {
    expect(formatBps(9940)).toBe('99,4');
    expect(formatBps(10_000)).toBe('100');
    expect(formatBps(5)).toBe('0,1');
    expect(formatBps(4)).toBe('0');
    expect(formatBps(1234)).toBe('12,3');
    expect(formatBps(-250)).toBe('−2,5');
  });
});
