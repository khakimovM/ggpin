import { HELD_AUTO_RELEASE_MAX, RELEASABLE_HELD_REASONS } from '@repo/shared';
import { RECHECK_MAX_AGE_MS } from '../../../fulfillment/fulfill-recipient';
import {
  RECHECK_SAFETY_MS,
  releaseVerdict,
  triageHeld,
  type HeldFacts,
  type ReleaseEvidence,
} from '../held-release-policy';

// Phase 5 S9e (D-64 (4), Q-2, Q-3, Q-8): the pure HELD policy. Refund from the latest hold at
// exactly HELD_MAX_AGE_MS; NO_PURCHASE never refunded or released; ADAPTER_ERROR never released;
// at most HELD_AUTO_RELEASE_MAX releases; a release only when the next run would not hold again.

const MAX_AGE = 21_600_000;
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const TON = 1_000_000_000n;

const facts = (over: Partial<HeldFacts> = {}): HeldFacts => ({
  reason: 'NO_ADAPTER',
  heldAtMs: NOW - 60_000,
  purchaseMatches: true,
  releasesUsed: 0,
  payout: 'clean',
  ...over,
});

const evidence = (over: Partial<ReleaseEvidence> = {}): ReleaseEvidence => ({
  route: { picked: 'FRAGMENT', issuer: 'FRAGMENT', orderAgeMs: 60_000 },
  currency: 'TON',
  maxCostMinor: 2n * TON,
  freshCostMinor: TON,
  knownCostMinor: TON,
  ton: {
    limits: { perOrderMaxNano: 50n * TON, dailyMaxNano: 500n * TON },
    spentLast24hNano: 0n,
    balanceNano: 100n * TON,
    feeReserveNano: TON / 20n,
  },
  supplierMaxPerOrderMicroUsdt: 200_000_000n,
  ...over,
});

describe('triageHeld', () => {
  it('Q-2: refund at exactly HELD_MAX_AGE_MS since the latest hold, not 1 ms before', () => {
    expect(triageHeld(facts({ heldAtMs: NOW - MAX_AGE }), NOW, MAX_AGE)).toEqual({
      kind: 'REFUND',
    });
    expect(triageHeld(facts({ heldAtMs: NOW - MAX_AGE + 1 }), NOW, MAX_AGE).kind).toBe('CHECK');
    expect(triageHeld(facts({ heldAtMs: NOW - MAX_AGE - 1 }), NOW, MAX_AGE).kind).toBe('REFUND');
  });

  it('every reason is refunded once old enough, ADAPTER_ERROR and the capped ones too', () => {
    for (const reason of ['ADAPTER_ERROR', 'NO_ADAPTER', null, 'LOW_BALANCE']) {
      const old = facts({ reason, heldAtMs: NOW - MAX_AGE, releasesUsed: 9 });
      expect(triageHeld(old, NOW, MAX_AGE)).toEqual({ kind: 'REFUND' });
    }
  });

  it('NO_PURCHASE (D-64 (6)): never refunded, never released, however old', () => {
    const old = facts({ purchaseMatches: false, heldAtMs: NOW - 10 * MAX_AGE });
    expect(triageHeld(old, NOW, MAX_AGE)).toEqual({ kind: 'NO_PURCHASE' });
    expect(triageHeld(facts({ purchaseMatches: false }), NOW, MAX_AGE)).toEqual({
      kind: 'NO_PURCHASE',
    });
  });

  it('S9f M-1 / L-1: a late fact or a live transfer keeps the order, however old or releasable', () => {
    for (const why of ['lateFact', 'liveTransfer'] as const) {
      const old = facts({ payout: why, heldAtMs: NOW - 10 * MAX_AGE });
      expect(triageHeld(old, NOW, MAX_AGE)).toEqual({ kind: 'PAYOUT', why });
      expect(triageHeld(facts({ payout: why }), NOW, MAX_AGE)).toEqual({ kind: 'PAYOUT', why });
      // A broken debit is still the money anomaly first (its own alert).
      const both = facts({ payout: why, purchaseMatches: false });
      expect(triageHeld(both, NOW, MAX_AGE)).toEqual({ kind: 'NO_PURCHASE' });
    }
    expect(triageHeld(facts(), NOW, MAX_AGE)).toEqual({ kind: 'CHECK', reason: 'NO_ADAPTER' });
  });

  it('ADAPTER_ERROR (attempt cap, NO_PURCHASE, STALE...) is never released; nor null or unknown', () => {
    expect(triageHeld(facts({ reason: 'ADAPTER_ERROR' }), NOW, MAX_AGE)).toEqual({
      kind: 'KEEP',
      why: 'adapterError',
    });
    for (const reason of [null, 'CONFIRM_TIMEOUT', 'HELD_EXPIRED', 'whatever']) {
      expect(triageHeld(facts({ reason }), NOW, MAX_AGE)).toEqual({
        kind: 'KEEP',
        why: 'notReleasable',
      });
    }
  });

  it('every releasable reason is checked while under the cap; the 4th release is KEEP', () => {
    for (const reason of RELEASABLE_HELD_REASONS) {
      expect(triageHeld(facts({ reason }), NOW, MAX_AGE)).toEqual({ kind: 'CHECK', reason });
      const used = facts({ reason, releasesUsed: HELD_AUTO_RELEASE_MAX - 1 });
      expect(triageHeld(used, NOW, MAX_AGE).kind).toBe('CHECK');
      const capped = facts({ reason, releasesUsed: HELD_AUTO_RELEASE_MAX });
      expect(triageHeld(capped, NOW, MAX_AGE)).toEqual({ kind: 'KEEP', why: 'releaseCap' });
    }
  });

  it('a clock it cannot read keeps the order (never refunded on NaN)', () => {
    expect(triageHeld(facts({ heldAtMs: Number.NaN }), NOW, MAX_AGE)).toEqual({
      kind: 'KEEP',
      why: 'badClock',
    });
    expect(triageHeld(facts({ releasesUsed: Number.NaN }), NOW, MAX_AGE)).toEqual({
      kind: 'KEEP',
      why: 'releaseCap',
    });
  });
});

describe('releaseVerdict', () => {
  it('each releasable reason: RELEASE when everything the run checks is fine', () => {
    for (const reason of RELEASABLE_HELD_REASONS) {
      expect(releaseVerdict(reason, evidence())).toEqual({ release: true });
    }
  });

  it('NO_ADAPTER: no healthy route in the order currency keeps every reason', () => {
    const none = evidence({ route: { picked: null, issuer: 'FRAGMENT', orderAgeMs: 0 } });
    for (const reason of RELEASABLE_HELD_REASONS) {
      expect(releaseVerdict(reason, none)).toEqual({ release: false, why: 'noRoute' });
    }
  });

  it('Q-8 / item 34: another issuer re-checks only while young: 31 min KEEP, 10 min RELEASE', () => {
    const route = (orderAgeMs: number) =>
      evidence({ route: { picked: 'FRAGMENT', issuer: 'RESELLER_STARS', orderAgeMs } });
    expect(releaseVerdict('NO_ADAPTER', route(31 * 60_000))).toEqual({
      release: false,
      why: 'recheckStale',
    });
    expect(releaseVerdict('NO_ADAPTER', route(10 * 60_000))).toEqual({ release: true });
    const edge = RECHECK_MAX_AGE_MS - RECHECK_SAFETY_MS;
    expect(releaseVerdict('NO_ADAPTER', route(edge - 1))).toEqual({ release: true });
    expect(releaseVerdict('NO_ADAPTER', route(edge)).release).toBe(false);
    // The issuer itself, or a plain handle: no re-check, any age.
    const own = { picked: 'FRAGMENT', issuer: 'FRAGMENT', orderAgeMs: 99 * 3_600_000 };
    expect(releaseVerdict('NO_ADAPTER', evidence({ route: own }))).toEqual({ release: true });
    const plain = { picked: 'FRAGMENT', issuer: null, orderAgeMs: 99 * 3_600_000 };
    expect(releaseVerdict('NO_ADAPTER', evidence({ route: plain }))).toEqual({ release: true });
  });

  it('PRICE_ABOVE_MAX: a fresh cost at or under the ceiling; none or above keeps', () => {
    expect(releaseVerdict('PRICE_ABOVE_MAX', evidence({ freshCostMinor: 2n * TON }))).toEqual({
      release: true,
    });
    expect(releaseVerdict('PRICE_ABOVE_MAX', evidence({ freshCostMinor: 2n * TON + 1n }))).toEqual({
      release: false,
      why: 'price',
    });
    expect(releaseVerdict('PRICE_ABOVE_MAX', evidence({ freshCostMinor: null }))).toEqual({
      release: false,
      why: 'noCost',
    });
    // Another reason without a fresh cost is not kept for it, but a cost above the ceiling is.
    expect(releaseVerdict('NO_ADAPTER', evidence({ freshCostMinor: null }))).toEqual({
      release: true,
    });
    expect(releaseVerdict('LOW_BALANCE', evidence({ freshCostMinor: 3n * TON })).release).toBe(
      false,
    );
  });

  it('LIMIT_PER_ORDER / LIMIT_DAILY: the larger cost against both TON limits', () => {
    const ton = evidence().ton;
    if (ton === null) throw new Error('no ton');
    const perOrder = evidence({ knownCostMinor: 51n * TON, maxCostMinor: 60n * TON });
    expect(releaseVerdict('LIMIT_PER_ORDER', perOrder)).toEqual({ release: false, why: 'limit' });
    const atLimit = evidence({ knownCostMinor: 50n * TON, maxCostMinor: 60n * TON });
    expect(releaseVerdict('LIMIT_PER_ORDER', atLimit)).toEqual({ release: true });
    const daily = (spent: bigint) => evidence({ ton: { ...ton, spentLast24hNano: spent } });
    expect(releaseVerdict('LIMIT_DAILY', daily(499n * TON))).toEqual({ release: true });
    expect(releaseVerdict('LIMIT_DAILY', daily(499n * TON + 1n))).toEqual({
      release: false,
      why: 'limit',
    });
    // The refused attempt's cost counts when it is above the order's.
    const refused = evidence({
      knownCostMinor: TON,
      freshCostMinor: 51n * TON,
      maxCostMinor: 60n * TON,
    });
    expect(releaseVerdict('LIMIT_PER_ORDER', refused).release).toBe(false);
  });

  it('LOW_BALANCE: a fresh balance covering cost + fee reserve; none or short keeps', () => {
    const ton = evidence().ton;
    if (ton === null) throw new Error('no ton');
    const balance = (balanceNano: bigint | null) => evidence({ ton: { ...ton, balanceNano } });
    expect(releaseVerdict('LOW_BALANCE', balance(TON + TON / 20n))).toEqual({ release: true });
    expect(releaseVerdict('LOW_BALANCE', balance(TON + TON / 20n - 1n))).toEqual({
      release: false,
      why: 'balance',
    });
    expect(releaseVerdict('LOW_BALANCE', balance(null))).toEqual({
      release: false,
      why: 'noBalance',
    });
    // A dry run has no reading: only LOW_BALANCE waits for one.
    expect(releaseVerdict('LIMIT_DAILY', balance(null))).toEqual({ release: true });
    expect(releaseVerdict('NO_ADAPTER', balance(TON))).toEqual({ release: false, why: 'balance' });
  });

  it('a USDT order: the supplier per-order cap; the TON-only reasons are never released', () => {
    const usdt = (knownCostMinor: bigint) =>
      evidence({
        currency: 'USDT',
        ton: null,
        knownCostMinor,
        freshCostMinor: knownCostMinor,
        maxCostMinor: 300_000_000n,
      });
    expect(releaseVerdict('LIMIT_PER_ORDER', usdt(200_000_000n))).toEqual({ release: true });
    expect(releaseVerdict('LIMIT_PER_ORDER', usdt(200_000_001n))).toEqual({
      release: false,
      why: 'limit',
    });
    expect(releaseVerdict('LIMIT_DAILY', usdt(1n)).release).toBe(false);
    expect(releaseVerdict('LOW_BALANCE', usdt(1n)).release).toBe(false);
  });

  it('a TON order without the wallet numbers, or a zero cost, is kept', () => {
    expect(releaseVerdict('NO_ADAPTER', evidence({ ton: null })).release).toBe(false);
    const zero = evidence({ knownCostMinor: 0n, freshCostMinor: null });
    expect(releaseVerdict('NO_ADAPTER', zero)).toEqual({ release: false, why: 'badAmount' });
  });
});
