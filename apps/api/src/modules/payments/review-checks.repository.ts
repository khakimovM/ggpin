import { Injectable } from '@nestjs/common';
import { manualCreditsSince, usedTopupBaseSince, type ManualCredits } from '@repo/db';
import type { Db } from '../../infra/prisma/db';

export interface MessagePayment {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly amountTiyin: bigint;
  readonly reviewId: string | null;
}

export interface CreditUserState {
  readonly isBlocked: boolean;
  readonly purchaseFrozen: boolean;
  readonly createdAt: Date;
  /** Base amounts counted in the daily window (the creation-time formula, D-37 (7)). */
  readonly usedBaseTiyin: bigint;
}

/** The reads a review decision checks before it writes (docs/05 §7, S8 round 1). */
@Injectable()
export class ReviewChecksRepository {
  /** The Payment of a bank message, whichever path made it (the matcher or a review). */
  messagePayment(db: Db, bankMessageId: string): Promise<MessagePayment | null> {
    return db.payment.findUnique({
      where: { bankMessageId },
      select: { id: true, userId: true, status: true, amountTiyin: true, reviewId: true },
    });
  }

  /** Another review of the same message was closed as paid back outside the bot. */
  async returnedOffline(db: Db, bankMessageId: string): Promise<boolean> {
    const count = await db.paymentReview.count({
      where: { bankMessageId, status: 'RESOLVED', resolution: 'RETURNED_OFFLINE' },
    });
    return count > 0;
  }

  /**
   * The worker's `overlappingIntent` predicate (apps/worker bank-message.repository): another
   * P2P intent of the card for the same amount whose reservation overlaps [createdAt, until) of
   * this one. Crediting this intent with `reservedUntil = until` would collide with it in the
   * EXCLUDE constraint (23P01). Read under the card lock, which the allocator takes too.
   */
  async overlappingIntent(
    db: Db,
    intent: { id: string; cardId: string | null; amountTiyin: bigint; createdAt: Date },
    until: Date,
  ): Promise<boolean> {
    const other = await db.paymentIntent.findFirst({
      where: {
        provider: 'P2P_CARD',
        cardId: intent.cardId,
        amountTiyin: intent.amountTiyin,
        id: { not: intent.id },
        createdAt: { lt: until },
        reservedUntil: { gt: intent.createdAt },
      },
      select: { id: true },
    });
    return other !== null;
  }

  /**
   * Money the owner gave the user by hand since `since` (D-47): the matcher's own predicate
   * (@repo/db `manualCreditsSince`), shown before a transfer is credited so it is not paid twice.
   */
  manualCreditsSince(db: Db, userId: string, since: Date): Promise<ManualCredits> {
    return manualCreditsSince(db, userId, since);
  }

  /** Read after the user's wallet lock; null when there is no such user. */
  async userState(
    db: Db,
    userId: string,
    since: Date,
    exceptIntentId: string | undefined,
  ): Promise<CreditUserState | null> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { isBlocked: true, purchaseFrozen: true, createdAt: true },
    });
    if (user === null) return null;
    return { ...user, usedBaseTiyin: await usedTopupBaseSince(db, userId, since, exceptIntentId) };
  }
}
