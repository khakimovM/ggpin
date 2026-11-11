import { describe, expect, it } from 'vitest';
import { expectCheck, expectPrismaCode } from './check-helpers';
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

// A CHECK passes when it evaluates to NULL, so every matrix below covers the NULL cases of the
// nullable columns as well as plain wrong values.

describe('PaymentIntent_p2p_check', () => {
  async function fixtures(): Promise<{ userId: string; cardId: string }> {
    return { userId: (await createUser()).id, cardId: (await createCard()).id };
  }

  const create = (data: IntentData) => db.paymentIntent.create({ data });

  it('accepts the suffix bounds 100 and 99 900 tiyin and a non-P2P intent without card fields', async () => {
    const { userId, cardId } = await fixtures();
    const other = await createUser();
    await create(p2pIntentData(userId, cardId, { amountTiyin: 5_000_100n }));
    await create(p2pIntentData(other.id, cardId, { amountTiyin: 5_099_900n }));
    await create({
      userId,
      provider: 'CLICK',
      amountTiyin: 1_000_000n,
      purpose: 'TOPUP',
      idempotencyKey: 'click-1',
      requestHash: 'h',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
  });

  it('rejects a suffix of 0, 99 or 100 000 tiyin and a base that is not a multiple of 1 000 so‘m', async () => {
    const { userId, cardId } = await fixtures();
    const bad: Partial<IntentData>[] = [
      { amountTiyin: 5_000_000n }, // suffix 0
      { amountTiyin: 5_000_099n }, // suffix 99 (and not whole so'm)
      { amountTiyin: 5_100_000n }, // suffix 100 000
      { amountTiyin: 4_999_900n }, // below the base
      { amountTiyin: 5_012_350n }, // not whole so'm
      { baseAmountTiyin: 5_050_000n, amountTiyin: 5_062_300n }, // base 50 500 so'm
      { baseAmountTiyin: 5_000_050n, amountTiyin: 5_012_350n }, // base not whole so'm
    ];
    for (const overrides of bad) {
      await expectCheck(
        create(p2pIntentData(userId, cardId, overrides)),
        'PaymentIntent_p2p_check',
      );
    }
  });

  it('rejects a P2P intent that lacks card, base amount or reservation (NULL cases)', async () => {
    const { userId, cardId } = await fixtures();
    const bad: Partial<IntentData>[] = [
      { cardId: null },
      { baseAmountTiyin: null },
      { reservedUntil: null },
    ];
    for (const overrides of bad) {
      await expectCheck(
        create(p2pIntentData(userId, cardId, overrides)),
        'PaymentIntent_p2p_check',
      );
    }
  });

  it('keeps the reservation at least as long as the request and the request after its creation', async () => {
    const { userId, cardId } = await fixtures();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 30 * MINUTE_MS);
    await create(p2pIntentData(userId, cardId, { createdAt, expiresAt, reservedUntil: expiresAt }));
    const other = await createUser();
    await expectCheck(
      create(
        p2pIntentData(other.id, cardId, {
          createdAt,
          expiresAt,
          reservedUntil: new Date(expiresAt.getTime() - 1),
        }),
      ),
      'PaymentIntent_p2p_check',
    );
    await expectCheck(
      create(
        p2pIntentData(other.id, cardId, {
          createdAt,
          expiresAt: createdAt,
          reservedUntil: new Date(createdAt.getTime() + GRACE_MS),
        }),
      ),
      'PaymentIntent_p2p_check',
    );
  });
});

describe('PaymentIntent_paid_check and PaymentIntent_p2p_paid_check', () => {
  it('PAID holds exactly when paidAt is set (any provider; NULL and wrong-status cases)', async () => {
    const user = await createUser();
    const clickIntent = (n: number, extra: object) => ({
      userId: user.id,
      provider: 'CLICK' as const,
      amountTiyin: 1_000_000n,
      purpose: 'TOPUP',
      idempotencyKey: `click-paid-${n}`,
      requestHash: 'h',
      expiresAt: new Date(Date.now() + HOUR_MS),
      ...extra,
    });
    await db.paymentIntent.create({ data: clickIntent(1, { status: 'PAID', paidAt: new Date() }) });
    await db.paymentIntent.create({ data: clickIntent(2, {}) });
    await expectCheck(
      db.paymentIntent.create({ data: clickIntent(3, { status: 'PAID' }) }),
      'PaymentIntent_paid_check',
    );
    for (const status of ['PENDING', 'EXPIRED', 'CANCELLED'] as const) {
      await expectCheck(
        db.paymentIntent.create({ data: clickIntent(4, { status, paidAt: new Date() }) }),
        'PaymentIntent_paid_check',
      );
    }
  });

  it('a P2P intent paid with a reservation that ends after paidAt is accepted', async () => {
    const user = await createUser();
    const card = await createCard();
    const paidAt = new Date();
    await db.paymentIntent.create({
      data: p2pIntentData(user.id, card.id, {
        status: 'PAID',
        paidAt,
        reservedUntil: new Date(paidAt.getTime() + GRACE_MS),
      }),
    });
  });

  it('a PAID P2P intent inserted with a reservation that ends before paidAt is refused', async () => {
    // (Updates to PAID are held to the exact formula by the trigger; this CHECK covers inserts.)
    const [user, other] = [await createUser(), await createUser()];
    const card = await createCard();
    const paidAt = new Date();
    const base = { status: 'PAID' as const, paidAt };
    await expectCheck(
      db.paymentIntent.create({
        data: p2pIntentData(user.id, card.id, {
          ...base,
          reservedUntil: new Date(paidAt.getTime() - 1),
          expiresAt: new Date(paidAt.getTime() - 2),
          createdAt: new Date(paidAt.getTime() - HOUR_MS),
        }),
      }),
      'PaymentIntent_p2p_paid_check',
    );
    await db.paymentIntent.create({
      data: p2pIntentData(other.id, card.id, {
        ...base,
        reservedUntil: new Date(paidAt.getTime() + GRACE_MS),
      }),
    });
  });
});

describe('PaymentIntent partial uniques', () => {
  it('a user has at most one PENDING P2P intent; a finished one frees the slot', async () => {
    const user = await createUser();
    const card = await createCard();
    const first = await db.paymentIntent.create({ data: p2pIntentData(user.id, card.id) });
    await expectPrismaCode(
      db.paymentIntent.create({
        data: p2pIntentData(user.id, card.id, { amountTiyin: 5_023_400n }),
      }),
      'P2002',
    );
    await db.paymentIntent.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
    await db.paymentIntent.create({
      data: p2pIntentData(user.id, card.id, { amountTiyin: 5_023_400n }),
    });
  });

  it('a user may have a PENDING non-P2P intent next to a P2P one', async () => {
    const user = await createUser();
    const card = await createCard();
    await db.paymentIntent.create({ data: p2pIntentData(user.id, card.id) });
    await db.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'CLICK',
        amountTiyin: 1_000_000n,
        purpose: 'TOPUP',
        idempotencyKey: 'click-2',
        requestHash: 'h',
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
  });

  it('two PENDING intents cannot wait for the same amount on one card; another card is fine', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const [cardOne, cardTwo] = [await createCard(), await createCard()];
    await db.paymentIntent.create({ data: p2pIntentData(a.id, cardOne.id) });
    // The partial unique (23505) and the reservation EXCLUDE (23P01) both refuse this write.
    // Which one Postgres reports first is not defined, so accept either.
    const error: unknown = await db.paymentIntent
      .create({ data: p2pIntentData(b.id, cardOne.id) })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(
      (error as { code?: unknown }).code === 'P2002' ||
        (error as Error).message.includes('PaymentIntent_card_amount_reserved_excl'),
    ).toBe(true);
    await db.paymentIntent.create({ data: p2pIntentData(b.id, cardTwo.id) });
  });

  it('PaymentIntent_card_amount_pending_key alone refuses a second PENDING of one amount', async () => {
    // The first request's reservation ended 3 days ago, so the EXCLUDE ranges do not overlap:
    // only the partial unique on (cardId, amountTiyin) WHERE status = 'PENDING' can refuse B.
    const [a, b] = [await createUser(), await createUser()];
    const card = await createCard();
    const old = new Date(Date.now() - 72 * HOUR_MS);
    await db.paymentIntent.create({ data: p2pIntentData(a.id, card.id, { createdAt: old }) });
    await expectPrismaCode(
      db.paymentIntent.create({ data: p2pIntentData(b.id, card.id) }),
      'P2002',
    );
    // Once A is no longer PENDING, the same amount is free.
    await db.paymentIntent.updateMany({ where: { userId: a.id }, data: { status: 'EXPIRED' } });
    await db.paymentIntent.create({ data: p2pIntentData(b.id, card.id) });
  });

  it('declares the partial unique indexes and the exclusion constraint', async () => {
    const rows = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('PaymentIntent_card_amount_pending_key', 'PaymentIntent_user_pending_p2p_key',
                          'PaymentIntent_card_amount_reserved_excl', 'TopupCard_bank_last4_active_key')`;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'PaymentIntent_card_amount_pending_key',
      'PaymentIntent_card_amount_reserved_excl',
      'PaymentIntent_user_pending_p2p_key',
      'TopupCard_bank_last4_active_key',
    ]);
  });
});

describe('PaymentIntent_base_positive_check', () => {
  it('rejects a zero base amount; NULL (non-P2P) stays allowed', async () => {
    const user = await createUser();
    const card = await createCard();
    await expectCheck(
      db.paymentIntent.create({
        data: p2pIntentData(user.id, card.id, { baseAmountTiyin: 0n, amountTiyin: 100n }),
      }),
      'PaymentIntent_base_positive_check',
    );
    await db.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'CLICK',
        amountTiyin: 1_000_000n,
        purpose: 'TOPUP',
        idempotencyKey: 'click-base',
        requestHash: 'h',
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
  });
});
