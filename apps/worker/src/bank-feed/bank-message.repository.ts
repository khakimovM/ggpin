import { Injectable } from '@nestjs/common';
import type { BankMessage, PaymentIntent, TopupCard, Tx } from '@repo/db';
import { PrismaService } from '../infra/prisma/prisma.service';
import { latestMatchableCreatedAt } from './match-rules';

export type IntentWithUser = PaymentIntent & {
  readonly user: { readonly isBlocked: boolean; readonly createdAt: Date };
};

/** What the post-commit effects need to know about a processed message (ids, no text). */
export interface ProcessedMessage {
  readonly id: string;
  readonly parseStatus: BankMessage['parseStatus'];
  readonly direction: BankMessage['direction'];
  readonly cardId: string | null;
  readonly senderId: bigint;
  readonly tgMessageId: bigint;
  readonly amountTiyin: bigint | null;
  readonly tgDate: Date;
  readonly outcome: {
    readonly outcome: 'CREDITED' | 'CARD_VERIFIED' | 'DEBIT_RECORDED' | 'REVIEW';
    readonly createdAt: Date;
    readonly review: {
      readonly id: string;
      readonly kind: string;
      readonly note: string | null;
    } | null;
    readonly payment: {
      readonly id: string;
      readonly userId: string;
      readonly intent: { readonly expiresAt: Date; readonly paidAt: Date | null } | null;
    } | null;
  } | null;
}

const P2P = 'P2P_CARD' as const;

// Every read of the matcher (docs/05 §6). Reads that decide a write take the `tx` of the
// card-locked transaction; nothing here writes.
@Injectable()
export class BankMessageRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client(): Tx {
    return this.prisma.client;
  }

  findMessage(id: string): Promise<(BankMessage & { outcome: { id: string } | null }) | null> {
    return this.prisma.client.bankMessage.findUnique({
      where: { id },
      include: { outcome: { select: { id: true } } },
    });
  }

  async hasOutcome(tx: Tx, bankMessageId: string): Promise<boolean> {
    const row = await tx.bankMessageOutcome.findUnique({
      where: { bankMessageId },
      select: { id: true },
    });
    return row !== null;
  }

  findForEffects(id: string): Promise<ProcessedMessage | null> {
    return this.prisma.client.bankMessage.findUnique({
      where: { id },
      select: {
        id: true,
        parseStatus: true,
        direction: true,
        cardId: true,
        senderId: true,
        tgMessageId: true,
        amountTiyin: true,
        tgDate: true,
        outcome: {
          select: {
            outcome: true,
            createdAt: true,
            review: { select: { id: true, kind: true, note: true } },
            payment: {
              select: {
                id: true,
                userId: true,
                intent: { select: { expiresAt: true, paidAt: true } },
              },
            },
          },
        },
      },
    });
  }

  /** The raw text, read only to re-parse the title (never logged). Null once purged. */
  async rawText(tx: Tx, bankMessageId: string): Promise<string | null> {
    const row = await tx.bankMessageText.findUnique({
      where: { bankMessageId },
      select: { text: true },
    });
    return row?.text ?? null;
  }

  findCard(tx: Tx, cardId: string): Promise<TopupCard | null> {
    return tx.topupCard.findUnique({ where: { id: cardId } });
  }

  /** An earlier message of the card that has no outcome yet (the chain must wait for it). */
  async hasUnprocessedPredecessor(tx: Tx, message: BankMessage): Promise<boolean> {
    if (message.cardId === null) return false;
    const row = await tx.bankMessage.findFirst({
      where: { cardId: message.cardId, tgMessageId: { lt: message.tgMessageId }, outcome: null },
      select: { id: true },
    });
    return row !== null;
  }

  /** The card's previous PARSED message, the link this one is chained to. */
  previousParsed(
    tx: Tx,
    message: BankMessage,
  ): Promise<{ balanceAfterTiyin: bigint | null } | null> {
    if (message.cardId === null) return Promise.resolve(null);
    return tx.bankMessage.findFirst({
      where: {
        cardId: message.cardId,
        parseStatus: 'PARSED',
        tgMessageId: { lt: message.tgMessageId },
      },
      orderBy: { tgMessageId: 'desc' },
      select: { balanceAfterTiyin: true },
    });
  }

  /**
   * Step 6 candidates: UNPAID intents of the card for exactly this amount whose reservation covers
   * the message time and that existed (within the clock leeway) when the money arrived.
   */
  candidates(tx: Tx, cardId: string, amountTiyin: bigint, tgDate: Date) {
    return tx.paymentIntent.findMany({
      where: {
        provider: P2P,
        cardId,
        amountTiyin,
        status: { in: ['PENDING', 'EXPIRED', 'CANCELLED'] },
        reservedUntil: { gte: tgDate },
        createdAt: { lte: latestMatchableCreatedAt(tgDate) },
      },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    });
  }

  /** A PAID intent still holding this amount: the same money came again (DUPLICATE, D-37 (5)). */
  paidHolder(tx: Tx, cardId: string, amountTiyin: bigint, tgDate: Date) {
    return tx.paymentIntent.findFirst({
      where: {
        provider: P2P,
        cardId,
        amountTiyin,
        status: 'PAID',
        reservedUntil: { gte: tgDate },
        createdAt: { lte: latestMatchableCreatedAt(tgDate) },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  }

  /** A confirmed payment of this amount on this card since `since`: a DEBIT may be its reversal. */
  recentPayment(tx: Tx, cardId: string, amountTiyin: bigint, since: Date) {
    return tx.payment.findFirst({
      where: {
        provider: P2P,
        status: 'CONFIRMED',
        amountTiyin,
        confirmedAt: { gte: since },
        bankMessage: { cardId },
      },
      orderBy: { confirmedAt: 'desc' },
      select: { id: true, intentId: true },
    });
  }

  /**
   * Another P2P intent of the card for the same amount whose reservation overlaps
   * [createdAt, until) of this one: what crediting this intent with `reservedUntil = until`
   * would collide with in the EXCLUDE constraint. Exists when the amount was handed to a newer
   * request after this one's reservation ended and the money is processed late (docs/05 §6).
   * Read under the card lock, which the API's allocator takes too.
   */
  overlappingIntent(
    tx: Tx,
    intent: Pick<PaymentIntent, 'id' | 'cardId' | 'amountTiyin' | 'createdAt'>,
    until: Date,
  ) {
    return tx.paymentIntent.findFirst({
      where: {
        provider: P2P,
        cardId: intent.cardId,
        amountTiyin: intent.amountTiyin,
        id: { not: intent.id },
        createdAt: { lt: until },
        reservedUntil: { gt: intent.createdAt },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  }

  /** Locks the intent row (FOR UPDATE) and reads it again with its owner's flags. */
  async lockIntent(tx: Tx, intentId: string): Promise<IntentWithUser | null> {
    await tx.$queryRaw`SELECT "id" FROM "PaymentIntent" WHERE "id" = ${intentId} FOR UPDATE`;
    return tx.paymentIntent.findUnique({
      where: { id: intentId },
      include: { user: { select: { isBlocked: true, createdAt: true } } },
    });
  }
}
