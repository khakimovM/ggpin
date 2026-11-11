import { RECENT_AMOUNT_WINDOW_MS, allocateAmount, type AmountUsage } from '../amount-allocator';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const BASE = 2_000_000n; // 20 000 so‘m
const HOUR = 3_600_000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const amount = (suffixSom: number): bigint => BASE + BigInt(suffixSom) * 100n;

describe('allocateAmount (docs/05 §3)', () => {
  it('returns base + 1..N whole so‘m', () => {
    for (let i = 0; i < 200; i += 1) {
      const result = allocateAmount({ baseTiyin: BASE, suffixMaxSom: 999, usage: [], now: NOW });
      const extra = (result ?? 0n) - BASE;
      expect(extra >= 100n && extra <= 99_900n && extra % 100n === 0n).toBe(true);
    }
  });

  it('never returns an amount still reserved; reservedUntil = now is already free (half-open range)', () => {
    const usage: AmountUsage[] = [
      { amountTiyin: amount(1), lastReservedUntil: at(1) },
      { amountTiyin: amount(2), lastReservedUntil: at(23 * HOUR) },
    ];
    for (let i = 0; i < 50; i += 1) {
      expect(allocateAmount({ baseTiyin: BASE, suffixMaxSom: 3, usage, now: NOW })).toBe(amount(3));
    }
    const boundary = [{ amountTiyin: amount(1), lastReservedUntil: NOW }];
    expect(allocateAmount({ baseTiyin: BASE, suffixMaxSom: 1, usage: boundary, now: NOW })).toBe(
      amount(1),
    );
  });

  it('prefers fresh amounts (not held in the last 7 days) over recently held free ones', () => {
    const usage: AmountUsage[] = [
      { amountTiyin: amount(1), lastReservedUntil: at(-HOUR) },
      { amountTiyin: amount(2), lastReservedUntil: at(-RECENT_AMOUNT_WINDOW_MS - 1) },
    ];
    for (let i = 0; i < 50; i += 1) {
      const result = allocateAmount({ baseTiyin: BASE, suffixMaxSom: 3, usage, now: NOW });
      expect([amount(2), amount(3)]).toContain(result);
    }
  });

  it('chooses among fresh amounts with the injected random source', () => {
    const picks = [0, 1, 2].map((index) =>
      allocateAmount({
        baseTiyin: BASE,
        suffixMaxSom: 3,
        usage: [],
        now: NOW,
        random: () => index,
      }),
    );
    expect(picks).toEqual([amount(1), amount(2), amount(3)]);
  });

  it('falls back to the least recently held free amount (LRU) when nothing is fresh', () => {
    const usage: AmountUsage[] = [
      { amountTiyin: amount(1), lastReservedUntil: at(-HOUR) },
      { amountTiyin: amount(2), lastReservedUntil: at(-5 * HOUR) },
      { amountTiyin: amount(3), lastReservedUntil: at(-2 * HOUR) },
      // several rows for one amount: its latest end counts
      { amountTiyin: amount(2), lastReservedUntil: at(-HOUR / 2) },
    ];
    expect(allocateAmount({ baseTiyin: BASE, suffixMaxSom: 3, usage, now: NOW })).toBe(amount(3));
    const older: AmountUsage[] = [
      { amountTiyin: amount(1), lastReservedUntil: at(-HOUR) },
      { amountTiyin: amount(2), lastReservedUntil: at(-5 * HOUR) },
    ];
    expect(allocateAmount({ baseTiyin: BASE, suffixMaxSom: 2, usage: older, now: NOW })).toBe(
      amount(2),
    );
  });

  it('returns null when every amount is still reserved (the caller tries the next card)', () => {
    const usage = [1, 2, 3].map((s) => ({ amountTiyin: amount(s), lastReservedUntil: at(HOUR) }));
    expect(allocateAmount({ baseTiyin: BASE, suffixMaxSom: 3, usage, now: NOW })).toBeNull();
  });

  it('ignores usage of amounts outside the base range', () => {
    const usage = [{ amountTiyin: BASE + 100_000n, lastReservedUntil: at(HOUR) }];
    expect(allocateAmount({ baseTiyin: BASE, suffixMaxSom: 1, usage, now: NOW })).toBe(amount(1));
  });
});
