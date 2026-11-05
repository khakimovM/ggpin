import {
  INTENT_STATUSES,
  intentTransitionRefusal,
  reservedUntilWhenPaid,
  type IntentStatus,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { expectGuard } from './check-helpers';
import { db } from './client';
import { createUser } from './factories';
import { HOUR_MS, createCard, p2pIntentData } from './payments-factories';

// The PaymentIntent_p2p_guard trigger mirrors the status graph of
// packages/shared/src/payments/intent-state.ts and adds what a row can prove on its own:
// immutable fields and a reservation that is exactly GREATEST(old, paidAt + grace), set only when
// the intent is paid, with a paidAt that lies in a plausible window.
// (The grace window and the actor depend on event time and caller, which stay in assertIntentTransition.)

type Row = Awaited<ReturnType<typeof db.paymentIntent.findUniqueOrThrow>>;

const later = (from: Date | null, ms: number): Date => new Date((from?.getTime() ?? 0) + ms);
const MINUTE_MS = 60_000;

/** The one reservedUntil the trigger accepts when `row` is paid at `paidAt`: GREATEST(old, paidAt + grace). */
function paidReservation(row: Row, paidAt: Date): Date {
  if (row.reservedUntil === null) throw new Error('a P2P intent always has reservedUntil');
  // The shared function the writers call: the trigger must accept exactly what it returns.
  return reservedUntilWhenPaid(
    { expiresAt: row.expiresAt, reservedUntil: row.reservedUntil },
    paidAt,
  );
}

/** The update that pays `row` correctly at `paidAt` (default now). */
function toPaid(row: Row, paidAt: Date = new Date()) {
  return { status: 'PAID' as const, paidAt, reservedUntil: paidReservation(row, paidAt) };
}

/**
 * A fresh P2P intent (own user and card), created `ageMs` ago, walked into `status` through
 * allowed transitions only.
 */
async function intentIn(status: IntentStatus, ageMs = 0): Promise<Row> {
  const user = await createUser();
  const card = await createCard();
  const createdAt = new Date(Date.now() - ageMs);
  const intent = await db.paymentIntent.create({
    data: p2pIntentData(user.id, card.id, { createdAt }),
  });
  if (status === 'PENDING') return intent;
  if (status !== 'PAID') {
    return db.paymentIntent.update({ where: { id: intent.id }, data: { status } });
  }
  return db.paymentIntent.update({ where: { id: intent.id }, data: toPaid(intent) });
}

describe('PaymentIntent status graph (trigger)', () => {
  it('allows exactly the transitions of intent-state.ts', async () => {
    // Every (from, to) pair, judged by the shared machine with the most permissive context
    // (admin actor, inside grace): the database must agree with it pair by pair.
    for (const from of INTENT_STATUSES) {
      for (const to of INTENT_STATUSES) {
        if (from === to) continue;
        const allowed =
          intentTransitionRefusal(from, to, { withinGrace: true, actor: 'admin' }) === null;
        const row = await intentIn(from);
        const data = to === 'PAID' ? toPaid(row) : { status: to };
        const attempt = db.paymentIntent.update({ where: { id: row.id }, data });
        if (allowed) {
          expect((await attempt).status, `${from} -> ${to}`).toBe(to);
        } else {
          await expectGuard(attempt, 'transition');
        }
      }
    }
  });

  it('PAID is final: it cannot be re-opened, expired or cancelled', async () => {
    for (const to of ['PENDING', 'EXPIRED', 'CANCELLED'] as const) {
      const paid = await intentIn('PAID');
      await expectGuard(
        db.paymentIntent.update({ where: { id: paid.id }, data: { status: to, paidAt: null } }),
        'transition',
      );
    }
  });

  it('a payment may keep its reservation unchanged (paidAt + grace not later than the old end)', async () => {
    const row = await intentIn('PENDING');
    const updated = await db.paymentIntent.update({
      where: { id: row.id },
      data: { status: 'PAID', paidAt: new Date() },
    });
    expect(updated.reservedUntil).toEqual(row.reservedUntil);
  });
});

describe('PaymentIntent immutable fields (trigger)', () => {
  it.each(INTENT_STATUSES)('refuses to change who, what or where in status %s', async (status) => {
    const row = await intentIn(status);
    const other = await createUser();
    const otherCard = await createCard();
    const changes = [
      { userId: other.id },
      { cardId: otherCard.id },
      { amountTiyin: row.amountTiyin + 100n },
      { baseAmountTiyin: 6_000_000n },
      { createdAt: new Date(Date.now() - HOUR_MS) },
      { expiresAt: later(row.expiresAt, HOUR_MS) },
      { provider: 'CLICK' as const },
    ];
    for (const data of changes) {
      await expectGuard(db.paymentIntent.update({ where: { id: row.id }, data }), 'immutable');
    }
  });

  it('keeps mutable columns mutable: pay token, status-neutral updates, in every status', async () => {
    for (const status of INTENT_STATUSES) {
      const row = await intentIn(status);
      const rotated = await db.paymentIntent.update({
        where: { id: row.id },
        data: { payTokenHash: `hash-${row.id}` },
      });
      expect(rotated.payTokenHash).toBe(`hash-${row.id}`);
      await db.paymentIntent.update({ where: { id: row.id }, data: { payTokenHash: null } });
    }
  });
});

describe('PaymentIntent reservation (trigger)', () => {
  it('is exactly GREATEST(old, paidAt + grace): shorter, longer and infinite are refused', async () => {
    for (const from of ['PENDING', 'EXPIRED', 'CANCELLED'] as const) {
      const row = await intentIn(from);
      const good = toPaid(row);
      const wrong = [
        new Date(good.reservedUntil.getTime() - 1),
        new Date(good.reservedUntil.getTime() + 1),
        row.reservedUntil ? new Date(row.reservedUntil.getTime() - HOUR_MS) : good.reservedUntil,
        new Date('9999-12-31T00:00:00Z'),
      ];
      for (const reservedUntil of wrong) {
        await expectGuard(
          db.paymentIntent.update({ where: { id: row.id }, data: { ...good, reservedUntil } }),
          'must equal GREATEST',
        );
      }
      await expect(
        db.$executeRaw`UPDATE "PaymentIntent" SET "status" = 'PAID', "paidAt" = ${good.paidAt},
          "reservedUntil" = 'infinity' WHERE "id" = ${row.id}`,
      ).rejects.toThrow(/GG001/);
    }
  });

  it('a late payment RAISES the reservation to paidAt + grace', async () => {
    // Created 25 h ago: its own window ended 30 minutes ago, so paying now must extend it.
    for (const from of ['EXPIRED', 'CANCELLED'] as const) {
      const row = await intentIn(from, 25 * HOUR_MS);
      expect(row.reservedUntil?.getTime()).toBeLessThan(Date.now());
      const paid = await db.paymentIntent.update({ where: { id: row.id }, data: toPaid(row) });
      expect(paid.reservedUntil?.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR_MS);
      expect(paid.reservedUntil).toEqual(paidReservation(row, paid.paidAt ?? new Date()));
    }
  });

  it('accepts exactly what reservedUntilWhenPaid returns, at every point around the crossover', async () => {
    // Young intent, paid inside its request window: paidAt + grace is SHORTER than the old end.
    const inside = await intentIn('PENDING');
    // Old intent (created 25 h ago): paid exactly at its deadline, 1 ms later, an hour ago, now.
    const paidAts = (row: Row): Date[] => [
      row.expiresAt,
      new Date(row.expiresAt.getTime() + 1),
      new Date(Date.now() - HOUR_MS),
      new Date(),
    ];
    const cases: [Row, Date][] = [[inside, new Date()]];
    for (let i = 0; i < 4; i++) {
      const row = await intentIn('EXPIRED', 25 * HOUR_MS);
      cases.push([row, paidAts(row)[i] ?? new Date()]);
    }
    for (const [row, paidAt] of cases) {
      const expected = paidReservation(row, paidAt);
      const paid = await db.paymentIntent.update({
        where: { id: row.id },
        data: { status: 'PAID', paidAt, reservedUntil: expected },
      });
      expect(paid.reservedUntil).toEqual(expected);
    }
  });

  it('paying inside the original window keeps the longer old reservation', async () => {
    const row = await intentIn('PENDING');
    const paid = await db.paymentIntent.update({ where: { id: row.id }, data: toPaid(row) });
    expect(paid.reservedUntil).toEqual(row.reservedUntil);
  });

  it('paidAt must lie between createdAt - 5 min and now + 5 min', async () => {
    const row = await intentIn('EXPIRED');
    const refused = [
      new Date(row.createdAt.getTime() - 6 * MINUTE_MS),
      new Date('2000-01-01T00:00:00Z'),
      new Date(Date.now() + 6 * MINUTE_MS),
      new Date('9999-12-31T00:00:00Z'),
    ];
    for (const paidAt of refused) {
      await expectGuard(
        db.paymentIntent.update({ where: { id: row.id }, data: toPaid(row, paidAt) }),
        'paidAt must lie',
      );
    }
    // Bank time is printed to the minute and its clock differs: the edges are accepted.
    for (const [i, paidAt] of [
      new Date(row.createdAt.getTime() - 4 * MINUTE_MS),
      new Date(Date.now() + 4 * MINUTE_MS),
    ].entries()) {
      const fresh = i === 0 ? row : await intentIn('EXPIRED');
      const paid = await db.paymentIntent.update({
        where: { id: fresh.id },
        data: toPaid(fresh, paidAt),
      });
      expect(paid.status).toBe('PAID');
    }
  });

  it('paying needs paidAt and reservedUntil in the same update', async () => {
    const row = await intentIn('EXPIRED');
    await expectGuard(
      db.paymentIntent.update({ where: { id: row.id }, data: { status: 'PAID' } }),
      'required when the intent is paid',
    );
  });

  it('is frozen outside the transition to PAID, in every status', async () => {
    for (const status of INTENT_STATUSES) {
      const row = await intentIn(status);
      await expectGuard(
        db.paymentIntent.update({
          where: { id: row.id },
          data: { reservedUntil: later(row.reservedUntil, HOUR_MS) },
        }),
        'only in the transition to PAID',
      );
      await expectGuard(
        db.paymentIntent.update({
          where: { id: row.id },
          data: { reservedUntil: new Date((row.reservedUntil?.getTime() ?? 0) - HOUR_MS) },
        }),
        'only in the transition to PAID',
      );
    }
  });

  it('a transition that is not to PAID cannot move it either', async () => {
    const pending = await intentIn('PENDING');
    for (const to of ['EXPIRED', 'CANCELLED'] as const) {
      await expectGuard(
        db.paymentIntent.update({
          where: { id: pending.id },
          data: { status: to, reservedUntil: later(pending.reservedUntil, HOUR_MS) },
        }),
        'only in the transition to PAID',
      );
    }
  });

  it('paidAt of a paid intent is final', async () => {
    const paid = await intentIn('PAID');
    await expectGuard(
      db.paymentIntent.update({
        where: { id: paid.id },
        data: { paidAt: later(paid.paidAt, -HOUR_MS) },
      }),
      'only in the transition to PAID',
    );
  });
});

describe('PaymentIntent guard scope', () => {
  it('does not touch intents of other providers', async () => {
    const user = await createUser();
    const intent = await db.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'CLICK',
        amountTiyin: 1_000_000n,
        purpose: 'TOPUP',
        idempotencyKey: 'click-guard',
        requestHash: 'h',
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
    const moved = await db.paymentIntent.update({
      where: { id: intent.id },
      data: { amountTiyin: 2_000_000n, status: 'CANCELLED' },
    });
    expect([moved.amountTiyin, moved.status]).toEqual([2_000_000n, 'CANCELLED']);
  });
});
