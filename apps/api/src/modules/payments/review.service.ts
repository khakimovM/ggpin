import { Inject, Injectable } from '@nestjs/common';
import type { PaymentReviewKind, PaymentReviewResolution, PaymentReviewStatus } from '@repo/db';
import { checkedId, validationError } from '../../common/admin/admin-input';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import type { Db } from '../../infra/prisma/db';
import {
  actorAfter,
  checkedActor,
  checkedReason,
  type CardAdminActor,
  type CheckedActor,
} from './card-admin.input';
import { CardPauseRepository, type PauseReason } from './card-pause.repository';
import { reasonsText } from './card-pause.service';
import { CardPoolRepository } from './card-pool.repository';
import { ReviewChecksRepository, type MessagePayment } from './review-checks.repository';
import {
  ReviewRepository,
  type ReviewDetails,
  type ReviewForAction,
  type ReviewListRow,
} from './review.repository';
import { ReviewEffects } from './review-effects';

export const REVIEW_LIST_MAX = 100;

export interface ReviewDecision {
  readonly reviewId: string;
  readonly resolution: PaymentReviewResolution;
  readonly auditId: string;
  /** review:accept-chain: auto-credit of the card was switched back on now. */
  readonly resumedCardId: string | null;
  /** review:accept-chain: the other reasons that keep the card paused (then nothing resumed). */
  readonly remainingPauseReasons: readonly PauseReason[];
  /** The owner's adminAction alert is queued. */
  readonly alertQueued: boolean;
}

type Committed = Omit<ReviewDecision, 'alertQueued'>;

interface Close {
  readonly action: string;
  readonly resolution: PaymentReviewResolution;
  readonly reason: string;
  readonly actor: CheckedActor;
}

/** review:show: the review and the Payment of its message, whichever path made it (m2). */
export interface ReviewView {
  readonly review: ReviewDetails;
  readonly messagePayment: MessagePayment | null;
}

/**
 * The review queue for the owner CLI (docs/05 §7). Reads, and the decisions that move no money:
 * - `ignore`: nothing to do with the money (IGNORED);
 * - `returnedOffline`: the transfer was paid back outside the bot (RETURNED_OFFLINE), only for
 *   a received PARSED CREDIT that no Payment credited (that one is payment:reverse, m2);
 * - `acceptChain`: a CHAIN_BREAK is explained, the message is the new head of the card's
 *   balance chain (the chain always links to the previous PARSED message) and auto-credit goes
 *   back on (CHAIN_ACCEPTED) unless another pause reason of the card stands (another open
 *   break, an integrity or failure review, the owner's standing card:pause of any age, S8 R1):
 *   then the review closes and the card stays paused (S8 M1). Refused while the message is a
 *   received credit nobody got: that money is decided first (review:credit / review:ignore /
 *   review:returned-offline, then card:resume), so accepting a chain never buries a payment.
 * Each is ONE transaction (the card lock first when a card changes, then the review row) with
 * its AuditLog row; a resolved review is never resolved again. Money: ReviewCreditService.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly repo: ReviewRepository,
    private readonly pool: CardPoolRepository,
    private readonly pauses: CardPauseRepository,
    private readonly checks: ReviewChecksRepository,
    private readonly effects: ReviewEffects,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(
    filter: {
      status?: PaymentReviewStatus;
      kind?: PaymentReviewKind;
      cardId?: string;
      limit?: number;
    } = {},
  ): Promise<ReviewListRow[]> {
    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_LIST_MAX) {
      throw validationError('limit');
    }
    const cardId = filter.cardId === undefined ? undefined : checkedId('cardId', filter.cardId);
    return this.repo.list({
      ...filter,
      ...(cardId === undefined ? {} : { cardId }),
      status: filter.status ?? 'OPEN',
      limit,
    });
  }

  async show(reviewId: string): Promise<ReviewView> {
    const review = await this.repo.show(checkedId('reviewId', reviewId));
    if (review === null) throw new AppError('NOT_FOUND');
    const messagePayment = await this.checks.messagePayment(
      this.pool.client,
      review.bankMessage.id,
    );
    return { review, messagePayment };
  }

  ignore(reviewId: string, reason: string, actor: CardAdminActor): Promise<ReviewDecision> {
    return this.close(reviewId, this.closing('REVIEW_IGNORE', 'IGNORED', reason, actor));
  }

  returnedOffline(
    reviewId: string,
    reason: string,
    actor: CardAdminActor,
  ): Promise<ReviewDecision> {
    const close = this.closing('REVIEW_RETURNED_OFFLINE', 'RETURNED_OFFLINE', reason, actor);
    return this.close(reviewId, close, async (review, tx) => {
      if (!isReceivedCredit(review)) throw validationError('review', 'NOT_A_PARSED_CREDIT');
      // Money that reached a wallet is taken back with payment:reverse, not closed as "returned".
      if (await this.repo.messageHasPayment(tx, review.bankMessage.id)) {
        throw validationError('bankMessage', 'ALREADY_CREDITED');
      }
    });
  }

  async acceptChain(
    reviewId: string,
    reason: string,
    actor: CardAdminActor,
  ): Promise<ReviewDecision> {
    const close = this.closing('REVIEW_ACCEPT_CHAIN', 'CHAIN_ACCEPTED', reason, actor);
    const known = await this.repo.find(checkedId('reviewId', reviewId));
    if (known === null) throw new AppError('NOT_FOUND');
    const cardId = known.bankMessage.cardId;
    if (known.kind !== 'CHAIN_BREAK' || cardId === null) {
      throw validationError('review', 'NOT_A_CHAIN_BREAK');
    }
    return this.close(
      reviewId,
      close,
      async (review, tx) => {
        if (
          isReceivedCredit(review) &&
          !(await this.repo.messageHasPayment(tx, review.bankMessage.id))
        ) {
          throw validationError('review', 'CREDIT_UNDECIDED');
        }
      },
      cardId,
    );
  }

  private closing(
    action: string,
    resolution: PaymentReviewResolution,
    reason: string,
    actor: CardAdminActor,
  ): Close {
    return { action, resolution, reason: checkedReason(reason), actor: checkedActor(actor) };
  }

  private async close(
    rawId: string,
    close: Close,
    check: (review: ReviewForAction, tx: Db) => Promise<void> = () => Promise.resolve(),
    cardToResume: string | null = null,
  ): Promise<ReviewDecision> {
    const reviewId = checkedId('reviewId', rawId);
    const committed = await this.pool.transaction(async (tx): Promise<Committed> => {
      if (cardToResume !== null) await this.pool.lockCard(tx, cardToResume);
      const review = await this.repo.lockReview(tx, reviewId);
      if (review === null) throw new AppError('NOT_FOUND');
      if (review.status !== 'OPEN') throw validationError('reviewStatus', review.status);
      await check(review, tx);
      // Another reason to keep the card paused (S8 M1): close the review, leave the card paused.
      const remaining =
        cardToResume === null ? [] : await this.pauses.reasons(tx, cardToResume, reviewId);
      const resumed =
        cardToResume !== null &&
        remaining.length === 0 &&
        (await this.repo.resumeAutoCredit(tx, cardToResume));
      const auditId = await this.repo.createAudit(tx, {
        ip: close.actor.ip,
        action: close.action,
        targetType: 'PaymentReview',
        targetId: reviewId,
        before: { status: 'OPEN', kind: review.kind },
        after: {
          status: 'RESOLVED',
          resolution: close.resolution,
          ...(cardToResume === null
            ? {}
            : {
                cardId: cardToResume,
                autoCreditResumed: resumed,
                remainingPauseReasons: reasonsText(remaining),
              }),
          ...actorAfter(close.actor),
        },
        reason: close.reason,
      });
      if (!(await this.repo.resolve(tx, reviewId, close.resolution, auditId, this.clock.now()))) {
        throw new AppError('INTERNAL_ERROR'); // cannot happen under the review row lock
      }
      return {
        reviewId,
        resolution: close.resolution,
        auditId,
        resumedCardId: resumed ? cardToResume : null,
        remainingPauseReasons: remaining,
      };
    });
    return { ...committed, alertQueued: await this.effects.adminAction(committed.auditId) };
  }
}

function isReceivedCredit(review: ReviewForAction): boolean {
  const message = review.bankMessage;
  return message.parseStatus === 'PARSED' && message.direction === 'CREDIT';
}
