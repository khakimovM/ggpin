import { describe, expect, it } from 'vitest';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { cardData, createCard, type CardData } from './payments-factories';

// A CHECK passes when it evaluates to NULL, so every matrix below covers the NULL cases of the
// nullable columns as well as plain wrong values.

describe('TopupCard_values_check', () => {
  it('accepts a valid card with and without a monthly limit', async () => {
    await createCard();
    await createCard({ monthlyLimitTiyin: 5_000_000_000n });
  });

  it('rejects a malformed pan, a last4 that is not its tail, bad limits and a blank holder', async () => {
    const bad: Partial<CardData>[] = [
      { pan: '860012345678901', last4: '8901' }, // 15 digits
      { pan: '86001234567890123', last4: '0123' }, // 17 digits
      { pan: '8600123456789abc', last4: '9abc' }, // not digits
      { pan: '8600123456789012', last4: '9999' }, // last4 is not right(pan, 4)
      { receiveLimitTiyin: 0n },
      { receiveLimitTiyin: -1n },
      { monthlyLimitTiyin: 0n },
      { monthlyLimitTiyin: -5n },
      { verifyAmountTiyin: 0n },
      { holderName: '   ' },
      { holderName: '' },
    ];
    for (const overrides of bad) {
      await expectCheck(createCard(overrides), 'TopupCard_values_check');
    }
  });
});

describe('TopupCard_retired_check', () => {
  it('RETIRED holds exactly when retiredAt is set', async () => {
    await createCard({ status: 'RETIRED', retiredAt: new Date() });
    await createCard({ status: 'ACTIVE' });
    await expectCheck(createCard({ status: 'RETIRED' }), 'TopupCard_retired_check');
    await expectCheck(
      createCard({ status: 'ACTIVE', retiredAt: new Date() }),
      'TopupCard_retired_check',
    );
    const card = await createCard({ status: 'DRAINING' });
    await expectCheck(
      db.topupCard.update({ where: { id: card.id }, data: { status: 'RETIRED' } }),
      'TopupCard_retired_check',
    );
    await db.topupCard.update({
      where: { id: card.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
  });
});

describe('TopupCard (bank, last4) among live cards', () => {
  it('rejects a second live card with the same bank and last4, in any live status', async () => {
    const base = cardData({ bank: 'HUMO', pan: '9860000000001111', last4: '1111' });
    await db.topupCard.create({ data: base });
    for (const status of ['VERIFYING', 'ACTIVE', 'DRAINING', 'FULL'] as const) {
      await expectPrismaCode(
        db.topupCard.create({
          data: { ...base, pan: '9860000000011111', status, verifiedAt: new Date() },
        }),
        'P2002',
      );
    }
  });

  it('allows the pair once the other card is RETIRED, and for another bank', async () => {
    const retired = cardData({ bank: 'HUMO', pan: '9860000000002222', last4: '2222' });
    await db.topupCard.create({
      data: { ...retired, status: 'RETIRED', retiredAt: new Date() },
    });
    await db.topupCard.create({ data: { ...retired, pan: '9860000000012222' } });
    await db.topupCard.create({
      data: { ...retired, bank: 'UZCARD', pan: '8600000000022222' },
    });
  });
});

describe('TopupCard identity is immutable (trigger)', () => {
  it('rejects a change of bank, pan, last4 or holderName with GG001', async () => {
    const card = await createCard();
    const changes = [
      { bank: 'HUMO' as const },
      { pan: '8600999999999999', last4: '9999' },
      { holderName: 'SOMEONE ELSE' },
    ];
    for (const data of changes) {
      await expectGuard(db.topupCard.update({ where: { id: card.id }, data }), 'immutable');
    }
    const after = await db.topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect([after.bank, after.pan, after.holderName]).toEqual([
      card.bank,
      card.pan,
      card.holderName,
    ]);
  });

  it('still lets status, limits and the pause flag change', async () => {
    const card = await createCard();
    const updated = await db.topupCard.update({
      where: { id: card.id },
      data: {
        status: 'ACTIVE',
        verifiedAt: new Date(),
        autoCreditPaused: true,
        receiveLimitTiyin: 7_000_000_000n,
        monthlyLimitTiyin: 1_000_000_000n,
      },
    });
    expect(updated.status).toBe('ACTIVE');
    expect(updated.autoCreditPaused).toBe(true);
    // Writing the same identity values back is not a change.
    await db.topupCard.update({
      where: { id: card.id },
      data: { pan: card.pan, holderName: card.holderName },
    });
  });
});

describe('TopupCard RETIRED is final (trigger)', () => {
  it('a retired card never leaves RETIRED and keeps its retiredAt', async () => {
    const retiredAt = new Date('2026-03-01T00:00:00Z');
    const card = await createCard({ status: 'ACTIVE' });
    const retired = await db.topupCard.update({
      where: { id: card.id },
      data: { status: 'RETIRED', retiredAt },
    });
    expect(retired.retiredAt).toEqual(retiredAt);
    for (const status of ['VERIFYING', 'ACTIVE', 'DRAINING', 'FULL'] as const) {
      await expectGuard(
        db.topupCard.update({
          where: { id: card.id },
          data: { status, retiredAt: null, verifiedAt: new Date() },
        }),
        'RETIRED is final',
      );
    }
    await expectGuard(
      db.topupCard.update({ where: { id: card.id }, data: { retiredAt: new Date() } }),
      'retiredAt is final',
    );
    // Other columns of a retired card are not frozen by this rule (limits, pause flag).
    await db.topupCard.update({ where: { id: card.id }, data: { autoCreditPaused: true } });
    const after = await db.topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect([after.status, after.retiredAt]).toEqual(['RETIRED', retiredAt]);
  });

  it('a card can still be retired from every live status', async () => {
    for (const status of ['VERIFYING', 'ACTIVE', 'DRAINING', 'FULL'] as const) {
      const card = await createCard({ status });
      await db.topupCard.update({
        where: { id: card.id },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
    }
  });
});

describe('TopupCard_verified_check', () => {
  it('only VERIFYING and RETIRED cards may lack verifiedAt', async () => {
    const verifiedAt = new Date();
    await createCard({ status: 'VERIFYING' });
    await createCard({ status: 'RETIRED', retiredAt: new Date() });
    for (const status of ['ACTIVE', 'DRAINING', 'FULL'] as const) {
      await createCard({ status, verifiedAt });
      await expectCheck(
        db.topupCard.create({ data: cardData({ status, verifiedAt: null }) }),
        'TopupCard_verified_check',
      );
    }
  });

  it('a VERIFYING card cannot go into service without verifiedAt', async () => {
    const card = await createCard();
    await expectCheck(
      db.topupCard.update({ where: { id: card.id }, data: { status: 'ACTIVE' } }),
      'TopupCard_verified_check',
    );
    await db.topupCard.update({
      where: { id: card.id },
      data: { status: 'ACTIVE', verifiedAt: new Date() },
    });
  });
});
