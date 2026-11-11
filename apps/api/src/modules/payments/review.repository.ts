import { Injectable } from '@nestjs/common';
import {
  appendLedgerEntry,
  lockWallet,
  type PaymentReviewKind,
  type PaymentReviewResolution,
  type PaymentReviewStatus,
  type Prisma,
} from '@repo/db';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface ReviewListFilter {
  readonly status?: PaymentReviewStatus;
  readonly kind?: PaymentReviewKind;
  readonly cardId?: string;
  readonly limit: number;
}

/** What a decision on a review needs from its bank message (no text, no balance). */
const ACTION_SELECT = {
  id: true,
  kind: true,
  status: true,
  note: true,
  createdAt: true,
  cardId: true,
  intentId: true,
  bankMessage: {
    select: {
      id: true,
      source: true,
      senderId: true,
      tgMessageId: true,
      tgDate: true,
      parseStatus: true,
      parserVersion: true,
      direction: true,
      amountTiyin: true,
      cardId: true,
    },
  },
} satisfies Prisma.PaymentReviewSelect;

export type ReviewForAction = Prisma.PaymentReviewGetPayload<{ select: typeof ACTION_SELECT }>;

const LIST_SELECT = {
  id: true,
  kind: true,
  status: true,
  note: true,
  resolution: true,
  createdAt: true,
  intentId: true,
  card: { select: { id: true, bank: true, last4: true } },
  bankMessage: { select: { direction: true, amountTiyin: true, last4: true, tgDate: true } },
} satisfies Prisma.PaymentReviewSelect;

export type ReviewListRow = Prisma.PaymentReviewGetPayload<{ select: typeof LIST_SELECT }>;

/** review:show: the only place the raw bank text is read for a person (docs/05 §7). */
const SHOW_SELECT = {
  ...LIST_SELECT,
  resolvedAt: true,
  resolvedAuditLog: { select: { id: true, reason: true, createdAt: true } },
  intent: { select: { id: true, userId: true, status: true, amountTiyin: true, cardId: true } },
  payment: { select: { id: true, userId: true, status: true, amountTiyin: true } },
  bankMessage: {
    select: {
      id: true,
      source: true,
      tgMessageId: true,
      tgDate: true,
      parseStatus: true,
      rejectReason: true,
      direction: true,
      amountTiyin: true,
      last4: true,
      channel: true,
      rawText: { select: { text: true } },
    },
  },
} satisfies Prisma.PaymentReviewSelect;

export type ReviewDetails = Prisma.PaymentReviewGetPayload<{ select: typeof SHOW_SELECT }>;

export interface IntentForCredit {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly cardId: string | null;
  readonly status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  readonly amountTiyin: bigint;
  readonly baseAmountTiyin: bigint | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly reservedUntil: Date | null;
}

export interface NewReviewPayment {
  readonly reviewId: string;
  readonly userId: string;
  readonly intentId: string | null;
  readonly amountTiyin: bigint;
  readonly message: ReviewForAction['bankMessage'];
  readonly now: Date;
}

export interface ReviewAudit {
  readonly ip: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before: Prisma.InputJsonValue;
  readonly after: Prisma.InputJsonValue;
  readonly reason: string;
}

/** All Prisma access of the review queue (docs/05 §7). Row locks are taken here, never in SQL elsewhere. */
@Injectable()
export class ReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(filter: ReviewListFilter): Promise<ReviewListRow[]> {
    return this.prisma.client.paymentReview.findMany({
      where: {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.cardId === undefined ? {} : { cardId: filter.cardId }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: filter.limit,
      select: LIST_SELECT,
    });
  }

  show(id: string): Promise<ReviewDetails | null> {
    return this.prisma.client.paymentReview.findUnique({ where: { id }, select: SHOW_SELECT });
  }

  /** Unlocked: only to learn which card to lock first (the message's card never changes). */
  find(id: string, db: Db = this.prisma.client): Promise<ReviewForAction | null> {
    return db.paymentReview.findUnique({ where: { id }, select: ACTION_SELECT });
  }

  /** Locks the review row until `tx` ends, then reads it: two decisions on one review queue here. */
  async lockReview(tx: Db, id: string): Promise<ReviewForAction | null> {
    await tx.$queryRaw`SELECT "id" FROM "PaymentReview" WHERE "id" = ${id} FOR UPDATE`;
    return this.find(id, tx);
  }

  async lockIntent(tx: Db, id: string): Promise<IntentForCredit | null> {
    await tx.$queryRaw`SELECT "id" FROM "PaymentIntent" WHERE "id" = ${id} FOR UPDATE`;
    return this.findIntent(id, tx);
  }

  findIntent(id: string, db: Db = this.prisma.client): Promise<IntentForCredit | null> {
    return db.paymentIntent.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        provider: true,
        cardId: true,
        status: true,
        amountTiyin: true,
        baseAmountTiyin: true,
        createdAt: true,
        expiresAt: true,
        reservedUntil: true,
      },
    });
  }

  /** Throws WalletNotFoundError when the user has no wallet (no such user). */
  lockWallet(tx: Db, userId: string): Promise<void> {
    return lockWallet(tx, userId);
  }

  async messageHasPayment(tx: Db, bankMessageId: string): Promise<boolean> {
    return (await tx.payment.count({ where: { bankMessageId } })) > 0;
  }

  /** The owner's credit of a reviewed P2P message: same txn id as an automatic credit would have. */
  async createPayment(tx: Db, p: NewReviewPayment): Promise<string> {
    const { message } = p;
    const payment = await tx.payment.create({
      data: {
        intentId: p.intentId,
        userId: p.userId,
        provider: 'P2P_CARD',
        providerTxnId: `${message.senderId.toString()}:${message.tgMessageId.toString()}`,
        amountTiyin: p.amountTiyin,
        status: 'CONFIRMED',
        bankMessageId: message.id,
        reviewId: p.reviewId,
        confirmedAt: p.now,
        // Ids and codes only: never the text, the balance or a card number.
        raw: {
          source: message.source,
          tgMessageId: message.tgMessageId.toString(),
          parserVersion: message.parserVersion,
          via: 'REVIEW',
        },
      },
      select: { id: true },
    });
    return payment.id;
  }

  /** PAID with the only reservation the database accepts; false when the status moved. */
  async markIntentPaid(
    tx: Db,
    intent: IntentForCredit,
    paidAt: Date,
    reservedUntil: Date,
  ): Promise<boolean> {
    const { count } = await tx.paymentIntent.updateMany({
      where: { id: intent.id, status: intent.status },
      data: { status: 'PAID', paidAt, reservedUntil },
    });
    return count === 1;
  }

  async appendTopup(tx: Db, userId: string, paymentId: string, amountTiyin: bigint) {
    return appendLedgerEntry(tx, {
      userId,
      kind: 'TOPUP',
      amountTiyin,
      refType: 'PAYMENT',
      refId: paymentId,
    });
  }

  async createAudit(tx: Db, data: ReviewAudit): Promise<string> {
    const row = await tx.auditLog.create({
      data: {
        // The owner CLI is not a user session: no actor id, the operator name is in `after`.
        actorType: 'CLI',
        actorId: null,
        ...data,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** OPEN -> RESOLVED with the audit row of the decision; false when it was not OPEN any more. */
  async resolve(
    tx: Db,
    id: string,
    resolution: PaymentReviewResolution,
    auditId: string,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.paymentReview.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'RESOLVED', resolution, resolvedAt: now, resolvedAuditLogId: auditId },
    });
    return count === 1;
  }

  /** Auto-credit back on (review:accept-chain); a RETIRED card stays as it is. */
  async resumeAutoCredit(tx: Db, cardId: string): Promise<boolean> {
    const { count } = await tx.topupCard.updateMany({
      where: { id: cardId, autoCreditPaused: true, status: { not: 'RETIRED' } },
      data: { autoCreditPaused: false },
    });
    return count === 1;
  }
}
