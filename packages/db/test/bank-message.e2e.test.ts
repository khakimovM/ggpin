import { describe, expect, it } from 'vitest';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import {
  HOUR_MS,
  cardData,
  createBankMessage,
  createCard,
  type BankMessageData,
} from './payments-factories';

describe('BankMessage_parsed_check', () => {
  it('accepts a complete PARSED message and an unparsed one without parse fields', async () => {
    await createBankMessage();
    await createBankMessage({
      parseStatus: 'UNRECOGNIZED',
      rejectReason: 'NO_AMOUNT',
      direction: null,
      amountTiyin: null,
      balanceAfterTiyin: null,
      last4: null,
      bankTxnAt: null,
    });
  });

  it('rejects a PARSED message missing any parse field, with a bad amount or a bad last4', async () => {
    const bad: Partial<BankMessageData>[] = [
      { direction: null },
      { amountTiyin: null },
      { amountTiyin: 0n },
      { amountTiyin: -100n },
      { balanceAfterTiyin: null },
      { last4: null },
      { last4: '123' },
      { last4: '12345' },
      { last4: 'abcd' },
      { bankTxnAt: null },
    ];
    for (const overrides of bad) {
      await expectCheck(createBankMessage(overrides), 'BankMessage_parsed_check');
    }
  });
});

describe('BankMessage_reason_check', () => {
  it('a message that is not PARSED must say why, a PARSED one need not', async () => {
    const unparsed = { direction: null, amountTiyin: null, balanceAfterTiyin: null, last4: null };
    await createBankMessage({ parseStatus: 'REJECTED', rejectReason: 'EDITED', ...unparsed });
    await createBankMessage({ rejectReason: null });
    for (const parseStatus of ['UNRECOGNIZED', 'REJECTED'] as const) {
      for (const rejectReason of [null, '', '   ']) {
        await expectCheck(
          createBankMessage({ parseStatus, rejectReason, bankTxnAt: null, ...unparsed }),
          'BankMessage_reason_check',
        );
      }
    }
  });
});

describe('BankMessage and BankMessageOutcome are append-only (trigger)', () => {
  it('BankMessage: UPDATE and DELETE are rejected with GG001, the row is unchanged', async () => {
    const message = await createBankMessage();
    await expectGuard(
      db.bankMessage.update({ where: { id: message.id }, data: { amountTiyin: 1n } }),
      'BankMessage is append-only',
    );
    await expectGuard(
      db.bankMessage.delete({ where: { id: message.id } }),
      'BankMessage is append-only',
    );
    await expectGuard(db.bankMessage.deleteMany({}), 'BankMessage is append-only');
    const after = await db.bankMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(after.amountTiyin).toBe(message.amountTiyin);
  });

  it('BankMessageOutcome: UPDATE and DELETE are rejected with GG001', async () => {
    const message = await createBankMessage();
    const outcome = await db.bankMessageOutcome.create({
      data: { bankMessageId: message.id, chainStatus: 'FIRST', outcome: 'DEBIT_RECORDED' },
    });
    await expectGuard(
      db.bankMessageOutcome.update({ where: { id: outcome.id }, data: { outcome: 'CREDITED' } }),
      'BankMessageOutcome is append-only',
    );
    await expectGuard(
      db.bankMessageOutcome.delete({ where: { id: outcome.id } }),
      'BankMessageOutcome is append-only',
    );
  });

  it('TRUNCATE still works (it is how the tests clean up)', async () => {
    await createBankMessage();
    await db.$executeRawUnsafe('TRUNCATE TABLE "BankMessage" CASCADE');
    expect(await db.bankMessage.count()).toBe(0);
  });
});

describe('bank message uniques', () => {
  it('(senderId, tgMessageId): a re-polled message is stored once', async () => {
    await createBankMessage({ senderId: 77n, tgMessageId: 5n });
    await expectPrismaCode(createBankMessage({ senderId: 77n, tgMessageId: 5n }), 'P2002');
    await createBankMessage({ senderId: 78n, tgMessageId: 5n });
  });
});

describe('BankMessageText retention purge (trigger)', () => {
  async function textRow(purgeAfter: Date, text = 'raw bank text') {
    const message = await createBankMessage();
    return db.bankMessageText.create({ data: { bankMessageId: message.id, text, purgeAfter } });
  }
  const where = (bankMessageId: string) => ({ bankMessageId });
  const GUARD = 'BankMessageText is append-only';

  it('erases the text once purgeAfter has passed', async () => {
    const row = await textRow(new Date(Date.now() - HOUR_MS));
    const purged = await db.bankMessageText.update({
      where: where(row.bankMessageId),
      data: { text: null },
    });
    expect(purged.text).toBeNull();
  });

  it('refuses to erase the text before purgeAfter', async () => {
    const row = await textRow(new Date(Date.now() + HOUR_MS));
    await expectGuard(
      db.bankMessageText.update({ where: where(row.bankMessageId), data: { text: null } }),
      GUARD,
    );
  });

  it('refuses any other UPDATE, even after purgeAfter: rewrite, restore, move the date', async () => {
    const row = await textRow(new Date(Date.now() - HOUR_MS));
    const id = where(row.bankMessageId);
    await expectGuard(db.bankMessageText.update({ where: id, data: { text: 'edited' } }), GUARD);
    await expectGuard(
      db.bankMessageText.update({
        where: id,
        data: { text: null, purgeAfter: new Date(Date.now() + HOUR_MS) },
      }),
      GUARD,
    );
    await db.bankMessageText.update({ where: id, data: { text: null } });
    await expectGuard(db.bankMessageText.update({ where: id, data: { text: 'restored' } }), GUARD);
    await expectGuard(
      db.bankMessageText.update({
        where: id,
        data: { purgeAfter: new Date(Date.now() + HOUR_MS) },
      }),
      GUARD,
    );
  });

  it('refuses DELETE, expired or not', async () => {
    const expired = await textRow(new Date(Date.now() - HOUR_MS));
    const live = await textRow(new Date(Date.now() + HOUR_MS));
    await expectGuard(db.bankMessageText.delete({ where: where(expired.bankMessageId) }), GUARD);
    await expectGuard(db.bankMessageText.delete({ where: where(live.bankMessageId) }), GUARD);
  });
});

describe('BankMessage card guard (trigger, GG003)', () => {
  const GG003 = 'GG003';

  it('accepts a card of the message bank and last4, and no card at all', async () => {
    const uzcard = await createCard({ bank: 'UZCARD' });
    const humo = await createCard({ bank: 'HUMO' });
    await createBankMessage({ source: 'UZCARD_BOT', cardId: uzcard.id, last4: uzcard.last4 });
    await createBankMessage({ source: 'HUMO_BOT', cardId: humo.id, last4: humo.last4 });
    await createBankMessage({ cardId: null });
  });

  it('refuses a card of the other bank', async () => {
    const humo = await createCard({ bank: 'HUMO' });
    await expectGuard(
      createBankMessage({ source: 'UZCARD_BOT', cardId: humo.id, last4: humo.last4 }),
      'came from',
      GG003,
    );
  });

  it('refuses a card whose last4 differs, or a message without last4', async () => {
    const card = await createCard();
    const other = card.last4 === '0000' ? '1111' : '0000';
    await expectGuard(
      createBankMessage({ source: 'UZCARD_BOT', cardId: card.id, last4: other }),
      'last4',
      GG003,
    );
    await expectGuard(
      createBankMessage({
        source: 'UZCARD_BOT',
        cardId: card.id,
        parseStatus: 'UNRECOGNIZED',
        rejectReason: 'NO_AMOUNT',
        direction: null,
        amountTiyin: null,
        balanceAfterTiyin: null,
        last4: null,
        bankTxnAt: null,
      }),
      'last4',
      GG003,
    );
  });

  it('a RETIRED card is only acceptable when no live card has the same bank and last4', async () => {
    const retired = await createCard({
      pan: '8600000000001111',
      last4: '1111',
      status: 'RETIRED',
      retiredAt: new Date(),
    });
    await createBankMessage({ source: 'UZCARD_BOT', cardId: retired.id, last4: '1111' });
    await db.topupCard.create({
      data: cardData({
        pan: '8600000000011111',
        last4: '1111',
        status: 'ACTIVE',
        verifiedAt: new Date(),
      }),
    });
    await expectGuard(
      createBankMessage({ source: 'UZCARD_BOT', cardId: retired.id, last4: '1111' }),
      'retired',
      GG003,
    );
  });

  it('accepts DRAINING and FULL cards: their messages still arrive and are matched', async () => {
    for (const status of ['DRAINING', 'FULL'] as const) {
      const card = await createCard({ status });
      await createBankMessage({ source: 'UZCARD_BOT', cardId: card.id, last4: card.last4 });
    }
  });

  it('among RETIRED cards with one bank and last4 only the latest retired one is accepted', async () => {
    const [older, newer] = [
      await createCard({
        bank: 'HUMO',
        pan: '9860000000002222',
        last4: '2222',
        status: 'RETIRED',
        retiredAt: new Date('2026-01-01T00:00:00Z'),
      }),
      await createCard({
        bank: 'HUMO',
        pan: '9860000000012222',
        last4: '2222',
        status: 'RETIRED',
        retiredAt: new Date('2026-06-01T00:00:00Z'),
      }),
    ];
    await expectGuard(
      createBankMessage({ source: 'HUMO_BOT', cardId: older.id, last4: '2222' }),
      'most recently retired',
      GG003,
    );
    await createBankMessage({ source: 'HUMO_BOT', cardId: newer.id, last4: '2222' });
  });

  it('retired in the same millisecond: the card with the greater id wins, whatever the writer', async () => {
    const retiredAt = new Date('2026-07-01T00:00:00Z');
    const retire = (pan: string) =>
      createCard({ bank: 'HUMO', pan, last4: '3333', status: 'RETIRED', retiredAt });
    const [one, two] = [await retire('9860000000003333'), await retire('9860000000013333')];
    // Same collation as the trigger's (retiredAt, id) comparison.
    const winner = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TopupCard" WHERE "id" IN (${one.id}, ${two.id}) ORDER BY "id" DESC LIMIT 1`;
    const winnerId = winner[0]?.id;
    const loserId = winnerId === one.id ? two.id : one.id;
    await expectGuard(
      createBankMessage({ source: 'HUMO_BOT', cardId: loserId, last4: '3333' }),
      'most recently retired',
      GG003,
    );
    await createBankMessage({ source: 'HUMO_BOT', cardId: winnerId, last4: '3333' });
  });

  it('leaves a card that does not exist to the foreign key', async () => {
    await expectPrismaCode(
      createBankMessage({ source: 'UZCARD_BOT', cardId: 'no-such-card', last4: '1234' }),
      'P2003',
    );
  });
});
