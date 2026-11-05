import { describe, expect, it } from 'vitest';
import {
  INTENT_STATUSES,
  IntentTransitionError,
  assertIntentTransition,
  canTransitionIntent,
  intentReservedUntil,
  intentTransitionRefusal,
  isWithinGrace,
  type IntentActor,
  type IntentStatus,
} from './intent-state';

type Pair = readonly [IntentStatus, IntentStatus];

// The full table; every ordered pair below is checked against it, so a transition nobody
// thought about cannot slip in.
const ALWAYS: readonly Pair[] = [
  ['PENDING', 'PAID'],
  ['PENDING', 'EXPIRED'],
  ['PENDING', 'CANCELLED'],
];
const has = (list: readonly Pair[], from: IntentStatus, to: IntentStatus): boolean =>
  list.some(([f, t]) => f === from && t === to);

function expectedRefusal(
  from: IntentStatus,
  to: IntentStatus,
  withinGrace: boolean,
  actor: IntentActor,
) {
  if (has(ALWAYS, from, to)) return null;
  // Only EXPIRED and CANCELLED can still become PAID, and only inside the grace window; a
  // cancelled request is never paid by the system, only by an audited admin. After the window no
  // intent changes state at all: money is credited through a review without an intent.
  if (from === 'CANCELLED' && to === 'PAID' && actor !== 'admin') return 'ACTOR_NOT_ALLOWED';
  if ((from === 'EXPIRED' || from === 'CANCELLED') && to === 'PAID') {
    return withinGrace ? null : 'GRACE_ELAPSED';
  }
  return 'NO_SUCH_TRANSITION';
}

function thrownBy(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('intent state machine', () => {
  for (const from of INTENT_STATUSES) {
    for (const to of INTENT_STATUSES) {
      for (const withinGrace of [true, false]) {
        for (const actor of ['system', 'admin'] as const) {
          const expected = expectedRefusal(from, to, withinGrace, actor);
          it(`${from} -> ${to} (grace=${String(withinGrace)}, ${actor}) is ${String(expected)}`, () => {
            const ctx = { withinGrace, actor };
            expect(intentTransitionRefusal(from, to, ctx)).toBe(expected);
            expect(canTransitionIntent(from, to, ctx)).toBe(expected === null);
            const failure = thrownBy(() => assertIntentTransition(from, to, ctx));
            if (expected === null) {
              expect(failure).toBeNull();
            } else {
              expect(failure).toBeInstanceOf(IntentTransitionError);
              expect(failure).toMatchObject({ from, to, reason: expected });
            }
          });
        }
      }
    }
  }

  it('an admin cannot move an intent after the grace window (no review shortcut on the intent)', () => {
    for (const from of ['EXPIRED', 'CANCELLED'] as const) {
      expect(intentTransitionRefusal(from, 'PAID', { withinGrace: false, actor: 'admin' })).toBe(
        'GRACE_ELAPSED',
      );
      expect(
        intentTransitionRefusal(from, 'PAID', { withinGrace: true, actor: 'admin' }),
      ).toBeNull();
    }
  });

  it('PAID is terminal, even for an admin', () => {
    for (const to of INTENT_STATUSES) {
      expect(canTransitionIntent('PAID', to, { withinGrace: true, actor: 'admin' })).toBe(false);
    }
  });

  it('a pending intent can be paid even after its deadline (the sweep has not run yet)', () => {
    expect(canTransitionIntent('PENDING', 'PAID', { withinGrace: false, actor: 'system' })).toBe(
      true,
    );
  });
});

describe('reservation window', () => {
  const expiresAt = new Date('2026-11-04T10:00:00.000Z');
  const grace = 86_400;
  const reservedUntil = intentReservedUntil({ expiresAt, paidAt: null }, grace);
  const at = (offsetMs: number): Date => new Date(reservedUntil.getTime() + offsetMs);

  it('an unpaid intent is reserved until expiresAt + grace', () => {
    expect(reservedUntil.toISOString()).toBe('2026-11-05T10:00:00.000Z');
  });

  it('a paid intent is reserved until paidAt + grace, so a repeat transfer is a DUPLICATE', () => {
    const paidAt = new Date('2026-11-04T09:05:00.000Z');
    expect(intentReservedUntil({ expiresAt, paidAt }, grace).toISOString()).toBe(
      '2026-11-05T09:05:00.000Z',
    );
  });

  it('is inclusive at the boundary and exclusive one millisecond later', () => {
    expect(isWithinGrace(at(0), reservedUntil)).toBe(true);
    expect(isWithinGrace(at(1), reservedUntil)).toBe(false);
    expect(isWithinGrace(at(-1), reservedUntil)).toBe(true);
  });

  it('a payment before the deadline is within grace', () => {
    expect(isWithinGrace(new Date('2026-11-04T09:00:00.000Z'), reservedUntil)).toBe(true);
  });
});
