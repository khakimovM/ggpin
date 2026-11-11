import type { BankMessage, PaymentReview, Prisma, TopupCard } from '../src/index';
import { db } from './client';
import { createUser } from './factories';

let counter = 0;
const next = (): number => ++counter;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** TOPUP_LATE_GRACE_SEC (24 h): how long a unique amount stays taken after its request ends. */
export const GRACE_MS = 24 * HOUR_MS;

export type CardData = Prisma.TopupCardUncheckedCreateInput;
export type IntentData = Prisma.PaymentIntentUncheckedCreateInput;
export type BankMessageData = Prisma.BankMessageUncheckedCreateInput;
export type ReviewData = Prisma.PaymentReviewUncheckedCreateInput;

/** A valid VERIFYING card; pan and last4 are unique per call so two cards never collide. */
export function cardData(overrides: Partial<CardData> = {}): CardData {
  const n = next();
  const pan = `8600${String(n).padStart(12, '0')}`;
  return {
    bank: 'UZCARD',
    pan,
    last4: pan.slice(-4),
    holderName: 'TEST HOLDER',
    receiveLimitTiyin: 100_000_000_000n,
    verifyAmountTiyin: 1_234_500n,
    // A card in service has been verified (TopupCard_verified_check).
    ...(overrides.status === 'ACTIVE' ||
    overrides.status === 'FULL' ||
    overrides.status === 'DRAINING'
      ? { verifiedAt: new Date() }
      : {}),
    ...overrides,
  };
}

export function createCard(overrides: Partial<CardData> = {}): Promise<TopupCard> {
  return db.topupCard.create({ data: cardData(overrides) });
}

/**
 * A valid PENDING P2P_CARD intent created at `createdAt` (default now): base 50 000 so'm + 123 so'm suffix, a
 * 30 minute request window and a reservation that outlives it by the grace.
 */
export function p2pIntentData(
  userId: string,
  cardId: string,
  overrides: Partial<IntentData> = {},
): IntentData {
  const now = Date.now();
  const createdAt = overrides.createdAt ?? new Date(now);
  const created = new Date(createdAt).getTime();
  const expiresAt = new Date(created + 30 * MINUTE_MS);
  return {
    userId,
    provider: 'P2P_CARD',
    cardId,
    baseAmountTiyin: 5_000_000n,
    amountTiyin: 5_012_300n,
    purpose: 'TOPUP',
    idempotencyKey: `p2p-${next()}`,
    requestHash: 'hash-a',
    createdAt,
    expiresAt,
    reservedUntil: new Date(expiresAt.getTime() + GRACE_MS),
    ...overrides,
  };
}

export function createBankMessage(overrides: Partial<BankMessageData> = {}): Promise<BankMessage> {
  const n = next();
  return db.bankMessage.create({
    data: {
      source: 'UZCARD_BOT',
      senderId: 1_000n,
      tgMessageId: BigInt(n),
      tgDate: new Date(),
      textSha256: `sha-${n}`,
      parseStatus: 'PARSED',
      parserVersion: 1,
      direction: 'CREDIT',
      amountTiyin: 5_012_300n,
      balanceAfterTiyin: 10_000_000n,
      last4: '1234',
      bankTxnAt: new Date(),
      ...overrides,
    },
  });
}

/** A review of an existing bank message (every review has one); creates the message if none given. */
export async function createReview(overrides: Partial<ReviewData> = {}): Promise<PaymentReview> {
  const bankMessageId = overrides.bankMessageId ?? (await createBankMessage()).id;
  return db.paymentReview.create({ data: { kind: 'NO_MATCH', ...overrides, bankMessageId } });
}

export type PaymentData = Prisma.PaymentUncheckedCreateInput;

let txn = 0;

/** A valid CONFIRMED P2P_CARD payment row for `userId` and `bankMessageId` (5 012 300 tiyin, like createBankMessage). */
export function paymentData(
  userId: string,
  bankMessageId: string,
  overrides: Partial<PaymentData> = {},
): PaymentData {
  return {
    userId,
    provider: 'P2P_CARD',
    providerTxnId: `1000:${++txn}`,
    amountTiyin: 5_012_300n,
    status: 'CONFIRMED',
    raw: {},
    bankMessageId,
    ...overrides,
  };
}

/** A user, a card, a PENDING intent and a parsed CREDIT message that fit each other. */
export async function p2pFixture(): Promise<{
  userId: string;
  cardId: string;
  cardLast4: string;
  intentId: string;
  messageId: string;
}> {
  const user = await createUser();
  const card = await createCard();
  const intent = await db.paymentIntent.create({ data: p2pIntentData(user.id, card.id) });
  // The message is the transfer this intent waits for: its card, its exact amount.
  const message = await createBankMessage({ cardId: card.id, last4: card.last4 });
  return {
    userId: user.id,
    cardId: card.id,
    cardLast4: card.last4,
    intentId: intent.id,
    messageId: message.id,
  };
}

export function createAuditLog(): Promise<{ id: string }> {
  return db.auditLog.create({
    data: {
      actorType: 'CLI',
      action: 'REVIEW_DECISION',
      targetType: 'PaymentReview',
      targetId: 'r',
    },
    select: { id: true },
  });
}
