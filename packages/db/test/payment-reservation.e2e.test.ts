import { describe, expect, it } from 'vitest';
import { db } from './client';
import { createUser } from './factories';
import {
  GRACE_MS,
  HOUR_MS,
  MINUTE_MS,
  createCard,
  p2pIntentData,
  type IntentData,
} from './payments-factories';

// H1: a unique amount stays taken on its card until PaymentIntent.reservedUntil, whatever the
// intent's status. The partial unique on PENDING cannot see a PAID, EXPIRED or CANCELLED row;
// the EXCLUDE constraint on (cardId, amountTiyin, tsrange(createdAt, reservedUntil)) can.
// Every first intent below is NOT PENDING, so the exclusion is the only thing that can refuse
// the second one.
const EXCLUSION = 'PaymentIntent_card_amount_reserved_excl';

async function expectReserved(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'the reservation must refuse this write').toBeInstanceOf(Error);
  expect((error as Error).message).toContain(EXCLUSION);
}

/** An intent that was created `ageMs` ago, with its normal 30 minute request and 24 h grace. */
function aged(userId: string, cardId: string, ageMs: number, overrides: Partial<IntentData> = {}) {
  return p2pIntentData(userId, cardId, { createdAt: new Date(Date.now() - ageMs), ...overrides });
}

describe('PaymentIntent reservation (EXCLUDE)', () => {
  it('a PAID amount cannot be handed out again inside its window', async () => {
    const [first, second] = [await createUser(), await createUser()];
    const card = await createCard();
    const paidAt = new Date(Date.now() - 10 * MINUTE_MS);
    await db.paymentIntent.create({
      data: aged(first.id, card.id, 40 * MINUTE_MS, {
        status: 'PAID',
        paidAt,
        reservedUntil: new Date(paidAt.getTime() + GRACE_MS),
      }),
    });
    await expectReserved(db.paymentIntent.create({ data: p2pIntentData(second.id, card.id) }));
  });

  it('EXPIRED and CANCELLED amounts stay taken until reservedUntil', async () => {
    const [first, second] = [await createUser(), await createUser()];
    const card = await createCard();
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      const amountTiyin = status === 'EXPIRED' ? 5_012_300n : 5_023_400n;
      await db.paymentIntent.create({
        data: aged(first.id, card.id, HOUR_MS, { status, amountTiyin }),
      });
      await expectReserved(
        db.paymentIntent.create({ data: p2pIntentData(second.id, card.id, { amountTiyin }) }),
      );
    }
  });

  it('the amount is free again after the window, and the window ends exactly at reservedUntil', async () => {
    const [first, second, third] = [await createUser(), await createUser(), await createUser()];
    const card = await createCard();
    const ended = aged(first.id, card.id, 3 * GRACE_MS, { status: 'EXPIRED' });
    await db.paymentIntent.create({ data: ended });
    await db.paymentIntent.create({ data: p2pIntentData(second.id, card.id) }); // free: window over

    // Half-open range: a new request created at the very instant the old one ends is allowed;
    // one millisecond earlier is not.
    const edge = new Date(Date.now() + HOUR_MS);
    const holder = p2pIntentData(second.id, card.id, {
      amountTiyin: 5_023_400n,
      createdAt: new Date(edge.getTime() - GRACE_MS - 30 * MINUTE_MS),
      status: 'EXPIRED',
    });
    expect(holder.reservedUntil).toEqual(edge);
    await db.paymentIntent.create({ data: holder });
    await expectReserved(
      db.paymentIntent.create({
        data: p2pIntentData(third.id, card.id, {
          amountTiyin: 5_023_400n,
          createdAt: new Date(edge.getTime() - 1),
        }),
      }),
    );
    await db.paymentIntent.create({
      data: p2pIntentData(third.id, card.id, { amountTiyin: 5_023_400n, createdAt: edge }),
    });
  });

  it('is scoped to one card and one amount', async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const [cardOne, cardTwo] = [await createCard(), await createCard()];
    await db.paymentIntent.create({ data: aged(a.id, cardOne.id, HOUR_MS, { status: 'EXPIRED' }) });
    await db.paymentIntent.create({ data: p2pIntentData(b.id, cardTwo.id) }); // other card
    await db.paymentIntent.create({
      data: p2pIntentData(c.id, cardOne.id, { amountTiyin: 5_034_500n }), // other amount
    });
  });

  it('paying extends the reservation: the amount stays taken past the original window', async () => {
    const [payer, other] = [await createUser(), await createUser()];
    const card = await createCard();
    // Created 25 h ago, so its original window ended 30 minutes ago; paid late, 10 minutes ago.
    const intent = await db.paymentIntent.create({
      data: aged(payer.id, card.id, 25 * HOUR_MS, { status: 'EXPIRED' }),
    });
    expect(intent.reservedUntil?.getTime()).toBeLessThan(Date.now());
    const paidAt = new Date(Date.now() - 10 * MINUTE_MS);
    await db.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'PAID',
        paidAt,
        reservedUntil: new Date(paidAt.getTime() + GRACE_MS),
      },
    });
    await expectReserved(db.paymentIntent.create({ data: p2pIntentData(other.id, card.id) }));
  });

  it('control: without the extension the same new request is accepted', async () => {
    const [payer, other] = [await createUser(), await createUser()];
    const card = await createCard();
    await db.paymentIntent.create({
      data: aged(payer.id, card.id, 25 * HOUR_MS, { status: 'EXPIRED' }),
    });
    await db.paymentIntent.create({ data: p2pIntentData(other.id, card.id) });
  });

  it('extending a reservation that someone else already took is refused (the matcher must review)', async () => {
    const [payer, other] = [await createUser(), await createUser()];
    const card = await createCard();
    const old = await db.paymentIntent.create({
      data: aged(payer.id, card.id, 25 * HOUR_MS, { status: 'EXPIRED' }),
    });
    await db.paymentIntent.create({ data: p2pIntentData(other.id, card.id) }); // reused after the window
    await expectReserved(
      db.paymentIntent.update({
        where: { id: old.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          reservedUntil: new Date(Date.now() + GRACE_MS),
        },
      }),
    );
  });

  it('parallel inserts of one card and amount: exactly one is stored', async () => {
    const users = await Promise.all([1, 2, 3, 4, 5].map(() => createUser()));
    const card = await createCard();
    const results = await Promise.allSettled(
      users.map((u) => db.paymentIntent.create({ data: p2pIntentData(u.id, card.id) })),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await db.paymentIntent.count({ where: { cardId: card.id } })).toBe(1);
  });

  it('parallel inserts of one amount with the first one PAID: none is stored', async () => {
    // Only the EXCLUDE constraint can refuse these (the first intent is not PENDING).
    const payer = await createUser();
    const rivals = await Promise.all([1, 2, 3].map(() => createUser()));
    const card = await createCard();
    const paidAt = new Date();
    await db.paymentIntent.create({
      data: aged(payer.id, card.id, 40 * MINUTE_MS, {
        status: 'PAID',
        paidAt,
        reservedUntil: new Date(paidAt.getTime() + GRACE_MS),
      }),
    });
    const results = await Promise.allSettled(
      rivals.map((u) => db.paymentIntent.create({ data: p2pIntentData(u.id, card.id) })),
    );
    expect(results.every((x) => x.status === 'rejected')).toBe(true);
    expect(await db.paymentIntent.count({ where: { cardId: card.id } })).toBe(1);
  });

  it('does not apply to other providers', async () => {
    const user = await createUser();
    const data = {
      userId: user.id,
      provider: 'CLICK' as const,
      amountTiyin: 1_000_000n,
      purpose: 'TOPUP',
      requestHash: 'h',
      expiresAt: new Date(Date.now() + HOUR_MS),
    };
    await db.paymentIntent.create({ data: { ...data, idempotencyKey: 'a' } });
    await db.paymentIntent.create({ data: { ...data, idempotencyKey: 'b' } });
  });
});
