import { describe, expect, it } from 'vitest';
import { MoneyError } from '../money';
import { capReferralBonus, reversalShare } from './reward-math';

describe('reversalShare (D-72 (7): cumulative, UP, never more than what is left)', () => {
  const base = {
    granted: 10_000n,
    alreadyReversed: 0n,
    refundedBeforeTiyin: 0n,
    paidTiyin: 1_000_000n,
    full: false,
  };

  it('takes the refund’s share of the grant, rounded UP', () => {
    expect(reversalShare({ ...base, refundTiyin: 500_000n })).toBe(5_000n);
    // 10 000 × 333 333 / 1 000 000 = 3 333.33 -> 3 334 (taken from a user: up)
    expect(reversalShare({ ...base, refundTiyin: 333_333n })).toBe(3_334n);
    expect(reversalShare({ ...base, refundTiyin: 1n })).toBe(1n);
  });

  it('review M1: three 100 so‘m refunds of a 1 000 000 so‘m order with 50 coins take 1 coin in all', () => {
    const order = { granted: 50n, paidTiyin: 100_000_000n, full: false };
    let reversed = 0n;
    let refunded = 0n;
    for (let i = 0; i < 3; i += 1) {
      reversed += reversalShare({
        ...order,
        alreadyReversed: reversed,
        refundedBeforeTiyin: refunded,
        refundTiyin: 10_000n,
      });
      refunded += 10_000n;
    }
    expect(reversed).toBe(1n);
  });

  it('a later refund takes only what its cumulative share adds', () => {
    // 333 333 + 333 333 = 666 666 -> ceil(6 666.66) = 6 667 in all; 3 334 already taken
    const second = { ...base, alreadyReversed: 3_334n, refundedBeforeTiyin: 333_333n };
    expect(reversalShare({ ...second, refundTiyin: 333_333n })).toBe(3_333n);
  });

  it('never more than is left; nothing when earlier reversals already cover the share', () => {
    expect(reversalShare({ ...base, alreadyReversed: 9_999n, refundTiyin: 1_000_000n })).toBe(1n);
    expect(reversalShare({ ...base, alreadyReversed: 10_000n, refundTiyin: 500_000n })).toBe(0n);
    expect(reversalShare({ ...base, alreadyReversed: 6_000n, refundTiyin: 500_000n })).toBe(0n);
  });

  it('a full refund takes exactly what is left', () => {
    const afterPartial = { ...base, alreadyReversed: 3_334n, refundTiyin: 1n, full: true };
    expect(reversalShare(afterPartial)).toBe(6_666n);
    expect(reversalShare({ ...base, refundTiyin: 0n, paidTiyin: 0n, full: true })).toBe(10_000n);
  });

  it('a reward of 0 has nothing to take back', () => {
    expect(reversalShare({ ...base, granted: 0n, refundTiyin: 500_000n })).toBe(0n);
  });

  it('refuses impossible input', () => {
    const bad = [
      { ...base, alreadyReversed: 10_001n, refundTiyin: 1n },
      { ...base, refundTiyin: 1_000_001n },
      { ...base, refundedBeforeTiyin: 999_999n, refundTiyin: 2n },
      { ...base, refundedBeforeTiyin: -1n, refundTiyin: 1n },
      { ...base, refundTiyin: 0n },
      { ...base, paidTiyin: 0n, refundTiyin: 1n },
      { ...base, granted: -1n, refundTiyin: 1n },
      { ...base, alreadyReversed: -1n, refundTiyin: 1n },
    ];
    for (const input of bad) expect(() => reversalShare(input)).toThrow(MoneyError);
  });

  // A seeded generator: the property runs the same cases every time (no flaky test).
  function seeded(seed: bigint): (bound: bigint) => bigint {
    let state = seed;
    return (bound) => {
      state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
      return (state >> 16n) % bound;
    };
  }
  const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

  it('property: partial reversals stay within ceil(grant × refunded / paid); a final full one closes it', () => {
    const next = seeded(20_261_124n);
    for (let run = 0; run < 500; run += 1) {
      const paidTiyin = 1n + next(50_000_000n);
      const granted = next(paidTiyin / 50n + 2n);
      let reversed = 0n;
      let refunded = 0n;
      const partials = Number(next(6n));
      for (let i = 0; i < partials && refunded < paidTiyin; i += 1) {
        const refundTiyin = 1n + next(paidTiyin - refunded);
        reversed += reversalShare({
          granted,
          alreadyReversed: reversed,
          refundedBeforeTiyin: refunded,
          refundTiyin,
          paidTiyin,
          full: false,
        });
        refunded += refundTiyin;
        // Never more than the cumulative share (kills "take everything at once") ...
        expect(reversed).toBeLessThanOrEqual(ceilDiv(granted * refunded, paidTiyin));
        // ... and never less (UP, not down).
        expect(reversed * paidTiyin >= refunded * granted).toBe(true);
      }
      const last = reversalShare({
        granted,
        alreadyReversed: reversed,
        refundedBeforeTiyin: refunded,
        refundTiyin: 1n,
        paidTiyin,
        full: true,
      });
      expect(reversed + last).toBe(granted);
    }
  });

  it('property: partial refunds that add up to the whole payment take the whole grant', () => {
    let reversed = 0n;
    let refunded = 0n;
    for (const refundTiyin of [250_000n, 250_000n, 499_999n, 1n]) {
      reversed += reversalShare({
        granted: 7n,
        alreadyReversed: reversed,
        refundedBeforeTiyin: refunded,
        refundTiyin,
        paidTiyin: 1_000_000n,
        full: false,
      });
      refunded += refundTiyin;
      expect(reversed).toBeLessThanOrEqual(7n);
    }
    expect(reversed).toBe(7n);
  });
});

describe('capReferralBonus (D-72 (3): what fits under the daily cap, gross, never carried)', () => {
  const CAP = 10_000_000n; // 100 000 so'm
  const cap = (bonusTiyin: bigint, grantedTodayTiyin: bigint): bigint =>
    capReferralBonus({ bonusTiyin, grantedTodayTiyin, capTiyin: CAP });

  it('review m8: 99 500 so‘m given today, a 1 000 so‘m bonus -> 500 so‘m', () => {
    expect(cap(100_000n, 9_950_000n)).toBe(50_000n);
  });

  it('under the cap the whole bonus is given', () => {
    expect(cap(100_000n, 0n)).toBe(100_000n);
    expect(cap(100_000n, 9_900_000n)).toBe(100_000n);
  });

  it('at or over the cap nothing is given (DAILY_CAP)', () => {
    expect(cap(100_000n, CAP)).toBe(0n);
    expect(cap(100_000n, CAP + 1n)).toBe(0n);
  });

  it('a room that is not a whole so‘m gives a whole so‘m, rounded down', () => {
    expect(cap(100_000n, 9_950_050n)).toBe(49_900n);
  });

  it('refuses negative input', () => {
    expect(() => cap(-1n, 0n)).toThrow(MoneyError);
    expect(() => cap(1n, -1n)).toThrow(MoneyError);
    const negativeCap = { bonusTiyin: 1n, grantedTodayTiyin: 0n, capTiyin: -1n };
    expect(() => capReferralBonus(negativeCap)).toThrow(MoneyError);
  });
});
