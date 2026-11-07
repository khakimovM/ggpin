import { describe, expect, it } from 'vitest';
import { alertRef, refIdSubject } from '../notify';
import { TASHKENT_UTC_OFFSET_MINUTES, tashkentMonthStart } from '../tashkent-time';
import {
  CARD_FULL_PERCENT,
  CARD_NEAR_LIMIT_PERCENT,
  capacityHoldEnd,
  capacityHoldWindow,
  freeCapacity,
  isOverReceiveLimit,
  receivedUsagePercent,
  reservedShareHigh,
  reservedSharePercent,
  type CardSums,
} from './card-capacity';
import { assertCardTransition, canTransitionCard } from './card-state';
import { topupTuningProblems } from './topup-tuning';

const sums = (over: Partial<CardSums> & { limit?: bigint; monthly?: bigint | null }): CardSums => ({
  card: { receiveLimitTiyin: over.limit ?? 1_000_000n, monthlyLimitTiyin: over.monthly ?? null },
  receivedTiyin: over.receivedTiyin ?? 0n,
  receivedMonthTiyin: over.receivedMonthTiyin ?? 0n,
  reservedTiyin: over.reservedTiyin ?? 0n,
});

describe('card capacity (shared by api and worker, D-42 (1))', () => {
  it('the hold window is reservedUntil > now and expiresAt > now - hold', () => {
    const now = new Date('2030-01-01T12:00:00.000Z');
    const window = capacityHoldWindow(now, 3_600);
    expect(window.reservedUntilAfter).toEqual(now);
    expect(window.expiresAtAfter).toEqual(new Date('2030-01-01T11:00:00.000Z'));
  });

  it('an intent counts while now < capacityHoldEnd, exactly the window predicate', () => {
    const expiresAt = new Date('2030-01-01T10:00:00.000Z');
    const reservedUntil = new Date('2030-01-02T10:00:00.000Z');
    const end = capacityHoldEnd({ status: 'EXPIRED', expiresAt, reservedUntil }, 3_600);
    expect(end).toEqual(new Date('2030-01-01T11:00:00.000Z'));
    const justBefore = capacityHoldWindow(new Date('2030-01-01T10:59:59.999Z'), 3_600);
    expect(expiresAt > justBefore.expiresAtAfter).toBe(true);
    const atEnd = capacityHoldWindow(new Date('2030-01-01T11:00:00.000Z'), 3_600);
    expect(expiresAt > atEnd.expiresAtAfter).toBe(false);
    expect(capacityHoldEnd({ status: 'PAID', expiresAt, reservedUntil }, 3_600)).toBeNull();
  });

  it('D-45: usage counts RECEIVED money only, the larger of lifetime and monthly, rounded down', () => {
    expect(receivedUsagePercent(sums({ receivedTiyin: 799_999n }))).toBe(79);
    expect(receivedUsagePercent(sums({ receivedTiyin: 800_000n }))).toBe(CARD_NEAR_LIMIT_PERCENT);
    expect(receivedUsagePercent(sums({ receivedTiyin: 1_000_000n }))).toBe(CARD_FULL_PERCENT);
    // Held amounts never move the card: even far past the limit nothing is reported...
    const held = sums({ receivedTiyin: 100_000n, reservedTiyin: 5_000_000n });
    expect(receivedUsagePercent(held)).toBe(10);
    // ...they only leave no room for a new request.
    expect(freeCapacity(held)).toBe(-4_100_000n);
    const monthly = sums({
      monthly: 100_000n,
      receivedTiyin: 10_000n,
      receivedMonthTiyin: 90_000n,
    });
    expect(receivedUsagePercent(monthly)).toBe(90);
    expect(freeCapacity(monthly)).toBe(10_000n);
    // The lifetime share is the larger one / the lifetime room is the smaller one.
    const lifetime = sums({
      monthly: 1_000_000n,
      receivedTiyin: 900_000n,
      receivedMonthTiyin: 100_000n,
    });
    expect(receivedUsagePercent(lifetime)).toBe(90);
    expect(freeCapacity(lifetime)).toBe(100_000n);
    expect(freeCapacity(sums({ receivedTiyin: 250_000n, reservedTiyin: 50_000n }))).toBe(700_000n);
  });

  it('over the receive limit looks at received money only', () => {
    expect(isOverReceiveLimit(sums({ receivedTiyin: 1_000_000n, reservedTiyin: 5n }))).toBe(false);
    expect(isOverReceiveLimit(sums({ receivedTiyin: 1_000_001n }))).toBe(true);
    expect(isOverReceiveLimit(sums({ monthly: 50n, receivedMonthTiyin: 51n }))).toBe(true);
  });

  it('the held share is measured against what the card may still receive (smaller remainder)', () => {
    // 1 000 000 limit, 600 000 received: 400 000 left; 200 000 held = 50 % (not above half).
    const half = sums({ receivedTiyin: 600_000n, reservedTiyin: 200_000n });
    expect(reservedSharePercent(half)).toBe(50);
    expect(reservedShareHigh(half)).toBe(false);
    const high = sums({ receivedTiyin: 600_000n, reservedTiyin: 200_001n });
    expect(reservedShareHigh(high)).toBe(true);
    // The monthly remainder (100 000 - 90 000 = 10 000) is the smaller one here.
    const monthly = sums({ monthly: 100_000n, receivedMonthTiyin: 90_000n, reservedTiyin: 5_001n });
    expect(reservedSharePercent(monthly)).toBe(50);
    expect(reservedShareHigh(monthly)).toBe(true);
  });

  it('a card with nothing left: any held amount is high and the share is 100', () => {
    const full = sums({ receivedTiyin: 1_000_000n, reservedTiyin: 1n });
    expect(reservedShareHigh(full)).toBe(true);
    expect(reservedSharePercent(full)).toBe(100);
    expect(reservedShareHigh(sums({ receivedTiyin: 1_000_000n }))).toBe(false);
  });
});

describe('card status graph (shared)', () => {
  it('VERIFYING -> ACTIVE and ACTIVE -> FULL are the worker moves; RETIRED is final', () => {
    expect(canTransitionCard('VERIFYING', 'ACTIVE')).toBe(true);
    expect(canTransitionCard('ACTIVE', 'FULL')).toBe(true);
    expect(canTransitionCard('DRAINING', 'FULL')).toBe(false);
    expect(() => {
      assertCardTransition('VERIFYING', 'ACTIVE');
    }).not.toThrow();
    expect(() => {
      assertCardTransition('RETIRED', 'ACTIVE');
    }).toThrow('Illegal card transition');
  });
});

describe('Asia/Tashkent time (one constant)', () => {
  it('is UTC+5 and the month starts at local midnight', () => {
    expect(TASHKENT_UTC_OFFSET_MINUTES).toBe(300);
    expect(tashkentMonthStart(new Date('2030-02-28T19:00:00.000Z'))).toEqual(
      new Date('2030-02-28T19:00:00.000Z'),
    );
    expect(tashkentMonthStart(new Date('2030-02-28T18:59:59.000Z'))).toEqual(
      new Date('2030-01-31T19:00:00.000Z'),
    );
  });
});

describe('composite alert refs', () => {
  it('reads the leading id back', () => {
    expect(refIdSubject(alertRef.cardSilent('cm3card01', new Date(5_000)))).toBe('cm3card01');
    expect(refIdSubject(alertRef.walletFrozen('cm3user01', 'cm3entry01'))).toBe('cm3user01');
    expect(refIdSubject('nounderscore')).toBeNull();
    expect(refIdSubject('_x')).toBeNull();
  });
});

describe('topupTuningProblems (api and worker boot)', () => {
  it('refuses a hold longer than the grace', () => {
    const problems = topupTuningProblems({
      NODE_ENV: 'test',
      TOPUP_LATE_GRACE_SEC: 3_600,
      TOPUP_CAPACITY_HOLD_SEC: 3_601,
      TOPUP_INTENT_TTL_SEC: 1_800,
    });
    expect(problems.map((p) => p.name)).toEqual(['TOPUP_CAPACITY_HOLD_SEC']);
  });

  it('production needs the 24 h grace and a hold at least as long as the request', () => {
    const base = {
      TOPUP_LATE_GRACE_SEC: 3_600,
      TOPUP_CAPACITY_HOLD_SEC: 600,
      TOPUP_INTENT_TTL_SEC: 1_800,
    };
    expect(topupTuningProblems({ ...base, NODE_ENV: 'production' }).map((p) => p.name)).toEqual([
      'TOPUP_LATE_GRACE_SEC',
      'TOPUP_CAPACITY_HOLD_SEC',
    ]);
    expect(
      topupTuningProblems({
        NODE_ENV: 'production',
        TOPUP_LATE_GRACE_SEC: 86_400,
        TOPUP_CAPACITY_HOLD_SEC: 3_600,
        TOPUP_INTENT_TTL_SEC: 1_800,
      }),
    ).toEqual([]);
    expect(topupTuningProblems({ ...base, NODE_ENV: 'development' })).toEqual([]);
  });
});
