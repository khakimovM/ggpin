import { ADMIN_SETTING_KEYS } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { SETTING_GROUPS, rateLabel, rateSeries, scaledRate } from '../pricing-model';

describe('pricing screen model', () => {
  it('places every setting key in exactly one card', () => {
    const placed = SETTING_GROUPS.flatMap((group) => group.keys);
    expect([...placed].sort()).toEqual([...ADMIN_SETTING_KEYS].sort());
  });

  it('reads decimal rates as integers, never floats', () => {
    expect(scaledRate('12655.5')).toBe(12_655_500_000n);
    expect(scaledRate('3.41')).toBe(3_410_000n);
    expect(scaledRate('0.1234567891')).toBe(123_456n);
  });

  const row = (rate: string, createdAt: string) => ({
    id: rate.replace('.', ''),
    pair: 'USDT_UZS' as const,
    rate,
    source: 's',
    createdAt,
  });

  it('draws the lowest rate at the bottom and the highest at the top, oldest first', () => {
    const series = rateSeries([
      row('12700', '2026-11-17T09:00:00Z'),
      row('12600', '2026-11-15T09:00:00Z'),
      row('12650', '2026-11-16T09:00:00Z'),
    ]);
    expect(series.ratios).toEqual([0, 0.5, 1]);
    expect(series.yLabels).toEqual(['12700', '12650', '12600']);
    expect(series.xLabels).toHaveLength(2);
  });

  it('puts the axis texts on the line scale: the top text is at least every point (R-4)', () => {
    // Newest first, as the API pages them; the newest is neither the max nor the min.
    const rows = [
      row('12655.5', '2026-11-17T09:00:00Z'),
      row('12710.25', '2026-11-16T09:00:00Z'),
      row('12590.75', '2026-11-15T09:00:00Z'),
      row('12640', '2026-11-14T09:00:00Z'),
    ];
    const series = rateSeries(rows);
    const top = scaledRate(series.yLabels[0]);
    const middle = scaledRate(series.yLabels[1]);
    const bottom = scaledRate(series.yLabels[2]);
    for (const one of rows) {
      expect(top).toBeGreaterThanOrEqual(scaledRate(one.rate));
      expect(bottom).toBeLessThanOrEqual(scaledRate(one.rate));
    }
    expect(series.yLabels).toEqual(['12710.25', '12650.5', '12590.75']);
    expect(middle).toBe((top + bottom) / 2n);
    // The highest point draws at the top text's height, the lowest at the bottom text's.
    expect(Math.max(...series.ratios)).toBe(1);
    expect(Math.min(...series.ratios)).toBe(0);
  });

  it('a flat series draws in the middle with one value on all three texts', () => {
    const series = rateSeries([
      row('3.41', '2026-11-17T09:00:00Z'),
      row('3.41', '2026-11-16T09:00:00Z'),
    ]);
    expect(series.ratios).toEqual([0.5, 0.5]);
    expect(series.yLabels).toEqual(['3.41', '3.41', '3.41']);
  });

  it('writes axis texts with two fraction digits at most', () => {
    expect(rateLabel(12_655_500_000n)).toBe('12655.5');
    expect(rateLabel(3_410_000n)).toBe('3.41');
    expect(rateLabel(3_405_000n)).toBe('3.4');
    expect(rateLabel(12_600_000_000n)).toBe('12600');
    // The top text rounds a cut remainder up, the others cut it.
    expect(rateLabel(3_415_900n, true)).toBe('3.42');
    expect(rateLabel(3_415_900n)).toBe('3.41');
    expect(rateLabel(3_999_999n, true)).toBe('4');
  });
});
