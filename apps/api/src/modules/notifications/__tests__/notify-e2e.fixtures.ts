import { randomBytes } from 'node:crypto';
import { appendLedgerEntry, type PrismaClient, type TopupCard } from '@repo/db';

// Rows for the notify e2e on the shared ggpin_test database, all SYNTHETIC (E-29): PAN prefix
// 9996 + this holder (the payments suites use 9999, the worker suite 9998), telegram ids and the
// bot sender id from the clock. `retireNotifyCards` leaves no live card behind, because the
// payments suites refuse to start next to a foreign live card.

export const NOTIFY_HOLDER = 'NOTIFY E2E HOLDER';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const runSeed = BigInt(Date.now());
let seq = 0;
const next = (): number => ++seq;
const SENDER_ID = 910_000_000_000n + (runSeed % 1_000_000n);
let messageSeq = runSeed * 1_000n;

export async function createUser(
  db: PrismaClient,
  opts: { locale?: 'uz' | 'ru'; botBlocked?: boolean } = {},
) {
  return db.user.create({
    data: {
      telegramId: runSeed * 1_000n + BigInt(next()),
      referralCode: `nt${randomBytes(6).toString('hex')}`,
      firstName: 'Test',
      locale: opts.locale ?? 'uz',
      botBlockedAt: opts.botBlocked === true ? new Date() : null,
      wallet: { create: {} },
    },
  });
}

export async function createCard(
  db: PrismaClient,
  limitTiyin = 1_000_000_000n,
): Promise<TopupCard> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const digits = randomBytes(6).readUIntBE(0, 6) % 1_000_000_000_000;
    const pan = `9996${String(digits).padStart(12, '0')}`;
    try {
      return await db.topupCard.create({
        data: {
          bank: 'UZCARD',
          pan,
          last4: pan.slice(-4),
          holderName: NOTIFY_HOLDER,
          status: 'ACTIVE',
          receiveLimitTiyin: limitTiyin,
          verifyAmountTiyin: 112_300n,
          verifiedAt: new Date(Date.now() - 10 * DAY),
        },
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'P2002')) throw error;
    }
  }
  throw new Error('no free synthetic last4');
}

/** A PARSED CREDIT (or an UNRECOGNIZED/REJECTED row) on `card`, the way the worker stores it. */
export function insertMessage(
  db: PrismaClient,
  card: Pick<TopupCard, 'id' | 'last4'> | null,
  amountTiyin: bigint,
  opts: { parseStatus?: 'PARSED' | 'REJECTED'; rejectReason?: string } = {},
) {
  messageSeq += 1n;
  const tgDate = new Date(Date.now() - MINUTE);
  const base = {
    source: 'UZCARD_BOT' as const,
    senderId: SENDER_ID,
    tgMessageId: messageSeq,
    tgDate,
    textSha256: randomBytes(32).toString('hex'),
    parserVersion: 1,
  };
  if (opts.parseStatus === 'REJECTED') {
    return db.bankMessage.create({
      data: { ...base, parseStatus: 'REJECTED', rejectReason: opts.rejectReason ?? 'EMPTY' },
    });
  }
  return db.bankMessage.create({
    data: {
      ...base,
      parseStatus: 'PARSED',
      direction: 'CREDIT',
      amountTiyin,
      balanceAfterTiyin: amountTiyin,
      last4: card?.last4 ?? '0000',
      bankTxnAt: tgDate,
      cardId: card?.id ?? null,
    },
  });
}

/**
 * A credited top-up exactly as the matcher leaves it: message, PAID intent, CONFIRMED payment
 * and its TOPUP entry (one transaction). `opening` adds an earlier entry so the balance differs
 * from the amount.
 */
export async function creditedPayment(
  db: PrismaClient,
  user: { id: string },
  card: TopupCard,
  amountTiyin: bigint,
  opening = 0n,
) {
  const message = await insertMessage(db, card, amountTiyin);
  const createdAt = new Date(message.tgDate.getTime() - 5 * MINUTE);
  const expiresAt = new Date(createdAt.getTime() + 30 * MINUTE);
  return db.$transaction(async (tx) => {
    const intent = await tx.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'P2P_CARD',
        cardId: card.id,
        amountTiyin,
        baseAmountTiyin: amountTiyin - (amountTiyin % 100_000n),
        status: 'PAID',
        purpose: 'TOPUP',
        idempotencyKey: `nt-${String(next())}-${randomBytes(4).toString('hex')}`,
        requestHash: 'h',
        createdAt,
        expiresAt,
        paidAt: message.tgDate,
        reservedUntil: new Date(expiresAt.getTime() + DAY),
      },
    });
    const payment = await tx.payment.create({
      data: {
        intentId: intent.id,
        userId: user.id,
        provider: 'P2P_CARD',
        providerTxnId: `${SENDER_ID.toString()}:${message.tgMessageId.toString()}`,
        amountTiyin,
        status: 'CONFIRMED',
        bankMessageId: message.id,
        confirmedAt: new Date(),
        raw: {},
      },
    });
    if (opening > 0n) {
      await appendLedgerEntry(tx, {
        userId: user.id,
        kind: 'ADJUSTMENT',
        amountTiyin: opening,
        refType: 'ADMIN_ACTION',
        refId: `nt-${randomBytes(6).toString('hex')}`,
      });
    }
    await appendLedgerEntry(tx, {
      userId: user.id,
      kind: 'TOPUP',
      amountTiyin,
      refType: 'PAYMENT',
      refId: payment.id,
    });
    return payment;
  });
}

/** Cancels what still waits on this suite's cards and retires them (RETIRED is final). */
export async function retireNotifyCards(db: PrismaClient): Promise<void> {
  const cards = await db.topupCard.findMany({
    where: { holderName: NOTIFY_HOLDER, status: { not: 'RETIRED' } },
    select: { id: true },
  });
  const ids = cards.map((c) => c.id);
  if (ids.length === 0) return;
  await db.paymentIntent.updateMany({
    where: { cardId: { in: ids }, status: 'PENDING' },
    data: { status: 'CANCELLED', payTokenHash: null },
  });
  await db.topupCard.updateMany({
    where: { id: { in: ids } },
    data: { status: 'RETIRED', retiredAt: new Date() },
  });
}
