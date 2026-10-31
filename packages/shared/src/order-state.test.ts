import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  CLIENT_STATUS_GROUP,
  CLIENT_STATUS_GROUPS,
  IllegalOrderTransitionError,
  isTerminalStatus,
  nextStatuses,
  ORDER_ACTORS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  orderStatusSchema,
  type OrderActor,
  type OrderStatus,
} from './order-state';

// Independent restatement of docs/06-FULFILLMENT.md + D-23, so a typo in the table under test
// cannot also hide itself here. [from, to, actors allowed]
const LEGAL: ReadonlyArray<readonly [OrderStatus, OrderStatus, readonly OrderActor[]]> = [
  ['PAID', 'QUEUED', ['system']],
  ['PAID', 'CANCELLED', ['admin']],
  ['QUEUED', 'PROCESSING', ['system']],
  ['QUEUED', 'CANCELLED', ['admin']],
  ['PROCESSING', 'DELIVERED', ['system']],
  ['PROCESSING', 'FAILED', ['system']],
  ['PROCESSING', 'HELD', ['system']],
  ['PROCESSING', 'NEEDS_REVIEW', ['system']],
  ['HELD', 'QUEUED', ['system', 'admin']],
  ['HELD', 'FAILED', ['system', 'admin']],
  ['HELD', 'CANCELLED', ['admin']],
  ['NEEDS_REVIEW', 'DELIVERED', ['reconciler', 'admin']],
  ['NEEDS_REVIEW', 'FAILED', ['reconciler', 'admin']],
  ['FAILED', 'REFUNDED', ['system', 'admin']],
  ['CANCELLED', 'REFUNDED', ['system', 'admin']],
  ['DELIVERED', 'REFUNDED', ['admin']],
];

const allowedActors = (from: OrderStatus, to: OrderStatus): readonly OrderActor[] =>
  LEGAL.find(([f, t]) => f === from && t === to)?.[2] ?? [];

const PAIRS = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as const));

describe('order state machine', () => {
  it('has exactly the OrderStatus enum from 03-DATA-MODEL and no QUOTED state', () => {
    expect([...ORDER_STATUSES].sort()).toEqual(
      [
        'PAID',
        'QUEUED',
        'PROCESSING',
        'HELD',
        'NEEDS_REVIEW',
        'DELIVERED',
        'FAILED',
        'CANCELLED',
        'REFUNDED',
      ].sort(),
    );
    expect(orderStatusSchema.safeParse('QUOTED').success).toBe(false);
    expect(orderStatusSchema.parse('PAID')).toBe('PAID');
  });

  it.each(LEGAL)('allows %s -> %s for the listed actors only', (from, to, actors) => {
    for (const actor of ORDER_ACTORS) {
      const expected = actors.includes(actor);
      expect(canTransition(from, to, actor), `${actor}`).toBe(expected);
      if (expected) expect(() => assertTransition(from, to, actor)).not.toThrow();
    }
  });

  it('classifies every (from, to, actor) in the full matrix', () => {
    expect(PAIRS).toHaveLength(81);
    for (const [from, to] of PAIRS) {
      for (const actor of ORDER_ACTORS) {
        const expected = allowedActors(from, to).includes(actor);
        expect(canTransition(from, to, actor), `${from}->${to} ${actor}`).toBe(expected);
        if (expected) {
          expect(() => assertTransition(from, to, actor)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to, actor), `${from}->${to} ${actor}`).toThrow(
            IllegalOrderTransitionError,
          );
        }
      }
    }
  });

  it('throws NO_SUCH_TRANSITION for every pair without an edge (incl. self-loops)', () => {
    const illegal = PAIRS.filter(([from, to]) => allowedActors(from, to).length === 0);
    expect(illegal.length).toBe(81 - LEGAL.length);
    for (const [from, to] of illegal) {
      for (const actor of ORDER_ACTORS) {
        expect(() => assertTransition(from, to, actor)).toThrow(
          expect.objectContaining({ from, to, actor, reason: 'NO_SUCH_TRANSITION' }),
        );
      }
    }
  });

  it('throws ACTOR_NOT_ALLOWED when the edge exists but the actor may not take it', () => {
    let seen = 0;
    for (const [from, to, actors] of LEGAL) {
      for (const actor of ORDER_ACTORS.filter((a) => !actors.includes(a))) {
        seen++;
        expect(() => assertTransition(from, to, actor)).toThrow(
          expect.objectContaining({ from, to, actor, reason: 'ACTOR_NOT_ALLOWED' }),
        );
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('keeps money-moving and human-decision edges admin-only', () => {
    expect(canTransition('DELIVERED', 'REFUNDED', 'system')).toBe(false);
    expect(canTransition('PAID', 'CANCELLED', 'system')).toBe(false);
    expect(canTransition('QUEUED', 'CANCELLED', 'system')).toBe(false);
    expect(canTransition('HELD', 'CANCELLED', 'system')).toBe(false);
    // No path back to the queue once a delivery went out or may have gone out.
    expect(canTransition('NEEDS_REVIEW', 'QUEUED', 'admin')).toBe(false);
    expect(canTransition('PROCESSING', 'QUEUED', 'system')).toBe(false);
  });

  it('NEEDS_REVIEW is resolved only by the reconciler or an admin, never by the processor', () => {
    // A system FAILED here would auto-refund an order whose payout may have gone out.
    for (const to of ['DELIVERED', 'FAILED'] as const) {
      expect(canTransition('NEEDS_REVIEW', to, 'system')).toBe(false);
      expect(() => assertTransition('NEEDS_REVIEW', to, 'system')).toThrow(
        expect.objectContaining({ reason: 'ACTOR_NOT_ALLOWED' }),
      );
      expect(canTransition('NEEDS_REVIEW', to, 'reconciler')).toBe(true);
      expect(canTransition('NEEDS_REVIEW', to, 'admin')).toBe(true);
    }
    expect(nextStatuses('NEEDS_REVIEW', 'system')).toEqual([]);
  });

  it('the reconciler may leave only NEEDS_REVIEW', () => {
    const edges = PAIRS.filter(([from, to]) => canTransition(from, to, 'reconciler'));
    expect(edges).toEqual([
      ['NEEDS_REVIEW', 'DELIVERED'],
      ['NEEDS_REVIEW', 'FAILED'],
    ]);
  });

  it('the transition table is deeply frozen: a mutation attempt throws and changes nothing', () => {
    const table = ORDER_TRANSITIONS as unknown as Record<string, Record<string, OrderActor[]>>;
    expect(Object.isFrozen(ORDER_TRANSITIONS)).toBe(true);
    for (const edges of Object.values(ORDER_TRANSITIONS)) {
      expect(Object.isFrozen(edges)).toBe(true);
      for (const actors of Object.values(edges)) expect(Object.isFrozen(actors)).toBe(true);
    }
    expect(() => table['NEEDS_REVIEW']?.['DELIVERED']?.push('system')).toThrow(TypeError);
    expect(() => {
      table['PAID'] = {};
    }).toThrow(TypeError);
    expect(() => {
      const paid = table['PAID'];
      if (paid) paid['DELIVERED'] = ['system'];
    }).toThrow(TypeError);
    expect(canTransition('NEEDS_REVIEW', 'DELIVERED', 'system')).toBe(false);
    expect(canTransition('PAID', 'DELIVERED', 'system')).toBe(false);
  });

  it('the thrown error carries from/to/actor and a readable message', () => {
    try {
      assertTransition('DELIVERED', 'QUEUED', 'system');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalOrderTransitionError);
      expect(error).toBeInstanceOf(Error);
      const e = error as IllegalOrderTransitionError;
      expect([e.from, e.to, e.actor, e.name]).toEqual([
        'DELIVERED',
        'QUEUED',
        'system',
        'IllegalOrderTransitionError',
      ]);
      expect(e.message).toBe(
        'Illegal order transition DELIVERED -> QUEUED by system (NO_SUCH_TRANSITION)',
      );
    }
  });

  it('lists next statuses per actor', () => {
    expect(nextStatuses('PROCESSING', 'system')).toEqual([
      'HELD',
      'NEEDS_REVIEW',
      'DELIVERED',
      'FAILED',
    ]);
    expect(nextStatuses('PROCESSING', 'admin')).toEqual([]);
    expect(nextStatuses('PAID', 'admin')).toEqual(['CANCELLED']);
    expect(nextStatuses('REFUNDED', 'admin')).toEqual([]);
  });

  it('only REFUNDED is terminal (DELIVERED and CANCELLED still have a refund edge)', () => {
    expect(ORDER_STATUSES.filter(isTerminalStatus)).toEqual(['REFUNDED']);
  });

  it('every status is reachable from PAID', () => {
    const reachable = new Set<OrderStatus>(['PAID']);
    for (const status of reachable) {
      for (const next of nextStatuses(status, 'system')) reachable.add(next);
      for (const next of nextStatuses(status, 'admin')) reachable.add(next);
      for (const next of nextStatuses(status, 'reconciler')) reachable.add(next);
    }
    expect([...reachable].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('maps every status to a client group from the API contract', () => {
    expect(Object.keys(CLIENT_STATUS_GROUP).sort()).toEqual([...ORDER_STATUSES].sort());
    for (const status of ORDER_STATUSES) {
      expect(CLIENT_STATUS_GROUPS).toContain(CLIENT_STATUS_GROUP[status]);
    }
    expect(CLIENT_STATUS_GROUP.PAID).toBe('QUEUED');
    expect(CLIENT_STATUS_GROUP.QUEUED).toBe('QUEUED');
    expect(CLIENT_STATUS_GROUP.HELD).toBe('REVIEW');
    expect(CLIENT_STATUS_GROUP.NEEDS_REVIEW).toBe('REVIEW');
    expect(CLIENT_STATUS_GROUP.FAILED).toBe('REFUNDED');
    expect(CLIENT_STATUS_GROUP.REFUNDED).toBe('REFUNDED');
    expect(CLIENT_STATUS_GROUP.CANCELLED).toBe('CANCELLED');
    expect(CLIENT_STATUS_GROUP.DELIVERED).toBe('DELIVERED');
    expect(CLIENT_STATUS_GROUP.PROCESSING).toBe('PROCESSING');
  });
});
