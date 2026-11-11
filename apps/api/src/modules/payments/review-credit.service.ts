import { Inject, Injectable } from '@nestjs/common';
import { WalletNotFoundError } from '@repo/db';
import { intentTransitionRefusal, isWithinGrace, reservedUntilWhenPaid } from '@repo/shared';
import { checkedId, validationError } from '../../common/admin/admin-input';
import type { OtpAnswer } from '../../common/admin/owner-otp/owner-otp';
import { requireOwnerConfirmation } from '../../common/admin/owner-otp/owner-otp';
import { OwnerOtpVerifier } from '../../common/admin/owner-otp/owner-otp.verifier';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import { actorAfter, checkedActor, checkedReason, type CardAdminActor } from './card-admin.input';
import { CardPoolRepository } from './card-pool.repository';
import { intentInsertConflict, isUniqueViolation } from './db-errors';
import { checkedTarget, ReviewCreditPreviewService } from './review-credit-preview.service';
import {
  creditOtpFlags,
  creditOtpTarget,
  creditableAmount,
  needsBankVerification,
  overrideNeeded,
  userCheckAudit,
  type CreditTarget,
} from './review-credit.checks';
import { ReviewChecksRepository } from './review-checks.repository';
import { ReviewRepository, type IntentForCredit, type ReviewForAction } from './review.repository';
import { ReviewEffects } from './review-effects';

export { creditableAmount, type CreditTarget } from './review-credit.checks';
export type { CreditPreview } from './review-credit-preview.service';

export interface CreditReviewInput {
  readonly reviewId: string;
  readonly target: CreditTarget;
  readonly reason: string;
  readonly actor: CardAdminActor;
  /** Above ADMIN_CONFIRM_THRESHOLD_TIYIN: the re-typed amount AND the owner's code (D-46). */
  readonly confirmAmountTiyin?: bigint;
  readonly otp?: OtpAnswer;
  /** The user is blocked or over the daily cap and the owner credits anyway (D-46 (2)). */
  readonly confirmOverride?: boolean;
  /** An integrity-flagged message the owner checked in the bank app (S8-L2). */
  readonly bankVerified?: boolean;
}

export interface ReviewCredit {
  readonly reviewId: string;
  readonly paymentId: string;
  readonly userId: string;
  readonly intentId: string | null;
  readonly amountTiyin: bigint;
  readonly auditId: string;
  /** The user's "wallet topped up" and the owner's adminAction are both queued. */
  readonly notified: boolean;
}

type Message = ReviewForAction['bankMessage'];

/** The unique keys that make one bank message one payment (migration p4_wallet_p2p). */
const PAYMENT_KEYS = ['Payment_bankMessageId_key', 'Payment_provider_providerTxnId_key'] as const;

/**
 * `review:credit` (docs/05 §7): the owner gives the money of a reviewed bank message to a user.
 * The owner's code is checked first (above the threshold, D-46), then ONE transaction, locks in
 * the matcher's order (I4): the message's card -> the review row -> the intent `FOR UPDATE` ->
 * the user's Wallet. In it: Payment(CONFIRMED, reviewId, bankMessageId) -> intent PAID (only
 * through the intent state machine, inside the grace window, and never onto an amount handed to
 * a newer request) -> LedgerEntry(TOPUP, PAYMENT/<paymentId>) -> AuditLog -> review RESOLVED.
 * Refused: a message already credited or returned offline; an integrity-flagged message without
 * `bankVerified`; a blocked user or one over the daily cap without `confirmOverride`.
 */
@Injectable()
export class ReviewCreditService {
  constructor(
    private readonly repo: ReviewRepository,
    private readonly checks: ReviewChecksRepository,
    private readonly pool: CardPoolRepository,
    private readonly effects: ReviewEffects,
    private readonly otp: OwnerOtpVerifier,
    private readonly previews: ReviewCreditPreviewService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Unlocked: what the CLI shows before it asks (ReviewCreditPreviewService). */
  preview(reviewId: string, target: CreditTarget) {
    return this.previews.preview(reviewId, target);
  }

  async credit(input: CreditReviewInput): Promise<ReviewCredit> {
    const reviewId = checkedId('reviewId', input.reviewId);
    const target = checkedTarget(input.target);
    const reason = checkedReason(input.reason);
    const actor = checkedActor(input.actor);
    const confirm = input.confirmAmountTiyin;
    const given = {
      override: input.confirmOverride === true,
      bankVerified: input.bankVerified === true,
    };
    const { override, bankVerified } = given;
    // The code is bound to the flags as the user's state reads now (S8 R2); checked again below.
    const otpFlags =
      input.otp === undefined
        ? null
        : creditOtpFlags((await this.previews.preview(reviewId, target)).user, given);
    const otpVerified = await this.otp.verifyIfGiven(
      input.otp,
      confirm,
      'review:credit',
      creditOtpTarget(reviewId, target),
      otpFlags ?? '',
    );

    // Unlocked read only to learn the card to lock first; a message's card never changes.
    const known = await this.repo.find(reviewId);
    if (known === null) throw new AppError('NOT_FOUND');
    const cardId = known.bankMessage.cardId;

    let committed: Omit<ReviewCredit, 'notified'>;
    try {
      committed = await this.pool.transaction(async (tx) => {
        if (cardId !== null) await this.pool.lockCard(tx, cardId);
        const review = await this.repo.lockReview(tx, reviewId);
        if (review === null) throw new AppError('NOT_FOUND');
        const amount = creditableAmount(review);
        if (needsBankVerification(review) && !bankVerified) {
          throw validationError('review', 'BANK_VERIFICATION_REQUIRED');
        }
        requireOwnerConfirmation(
          amount,
          confirm,
          otpVerified,
          this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN,
        );
        const message = review.bankMessage;
        if (await this.repo.messageHasPayment(tx, message.id)) {
          throw validationError('bankMessage', 'ALREADY_CREDITED');
        }
        if (await this.checks.returnedOffline(tx, message.id)) {
          throw validationError('bankMessage', 'RETURNED_OFFLINE');
        }
        const intent =
          'intentId' in target ? await this.intentFor(tx, target.intentId, message) : null;
        const userId = intent?.userId ?? ('userId' in target ? target.userId : null);
        if (userId === null) throw new AppError('INTERNAL_ERROR');
        await this.lockWallet(tx, userId);
        const user = await this.previews.userCheck(tx, userId, intent, amount);
        const refusal = overrideNeeded(user);
        if (refusal !== null && !override) throw validationError('user', refusal);
        // The state changed since the code was issued: the owner confirmed something else.
        if (otpFlags !== null && creditOtpFlags(user, given) !== otpFlags) {
          throw validationError('otp', 'OTP_MISMATCH');
        }

        const now = this.clock.now();
        const paymentId = await this.repo.createPayment(tx, {
          reviewId,
          userId,
          intentId: intent?.id ?? null,
          amountTiyin: amount,
          message,
          now,
        });
        if (intent !== null) await this.payIntent(tx, intent, message.tgDate);
        await this.repo.appendTopup(tx, userId, paymentId, amount);
        const auditId = await this.repo.createAudit(tx, {
          ip: actor.ip,
          action: 'REVIEW_CREDIT',
          targetType: 'PaymentReview',
          targetId: reviewId,
          before: { status: 'OPEN', kind: review.kind, intentStatus: intent?.status ?? null },
          after: {
            status: 'RESOLVED',
            resolution: 'CREDITED_USER',
            paymentId,
            userId,
            intentId: intent?.id ?? null,
            amountTiyin: amount.toString(),
            otpVerified,
            user: userCheckAudit(user),
            override: refusal !== null && override,
            bankVerified: needsBankVerification(review) && bankVerified,
            ...actorAfter(actor),
          },
          reason,
        });
        if (!(await this.repo.resolve(tx, reviewId, 'CREDITED_USER', auditId, now))) {
          throw new AppError('INTERNAL_ERROR'); // cannot happen under the review row lock
        }
        const intentId = intent?.id ?? null;
        return { reviewId, paymentId, userId, intentId, amountTiyin: amount, auditId };
      });
    } catch (error) {
      // Another review of the same message credited it in between (unique bankMessageId).
      if (PAYMENT_KEYS.some((index) => isUniqueViolation(error, index))) {
        throw validationError('bankMessage', 'ALREADY_CREDITED');
      }
      // Belt and braces: the overlap check below runs under the card lock, so this means a
      // reservation appeared that the predicate does not know (still never a raw 23P01).
      if (intentInsertConflict(error) === 'AMOUNT_TAKEN') {
        throw validationError('intentId', 'AMOUNT_REALLOCATED');
      }
      throw error;
    }
    const notified = await this.effects.credited(
      committed.userId,
      committed.paymentId,
      committed.auditId,
    );
    return { ...committed, notified };
  }

  /**
   * `--intent` works only for the request this transfer could be: a P2P request on the message's
   * card for exactly its amount (the Payment trigger refuses anything else too), not paid yet,
   * the transition allowed now (CANCELLED/EXPIRED only inside the grace window), and its amount
   * not handed to a newer request since (the worker's AMOUNT_REALLOCATED, m1).
   */
  private async intentFor(tx: Db, intentId: string, message: Message): Promise<IntentForCredit> {
    const intent = await this.repo.lockIntent(tx, intentId);
    if (intent === null) throw new AppError('NOT_FOUND');
    if (
      intent.provider !== 'P2P_CARD' ||
      message.cardId === null ||
      intent.cardId !== message.cardId ||
      intent.amountTiyin !== message.amountTiyin ||
      intent.reservedUntil === null
    ) {
      throw validationError('intentId', 'MISMATCH');
    }
    const refusal = intentTransitionRefusal(intent.status, 'PAID', {
      actor: 'admin',
      withinGrace: isWithinGrace(message.tgDate, intent.reservedUntil),
    });
    if (refusal !== null) throw validationError('intentId', refusal);
    if (await this.checks.overlappingIntent(tx, intent, this.paidUntil(intent, message.tgDate))) {
      throw validationError('intentId', 'AMOUNT_REALLOCATED');
    }
    return intent;
  }

  /** paidAt = when the money arrived (the message's Telegram date), as the matcher does. */
  private async payIntent(tx: Db, intent: IntentForCredit, paidAt: Date): Promise<void> {
    const reservedUntil = this.paidUntil(intent, paidAt);
    if (!(await this.repo.markIntentPaid(tx, intent, paidAt, reservedUntil))) {
      throw new AppError('INTERNAL_ERROR'); // cannot happen under the row lock
    }
  }

  private paidUntil(intent: IntentForCredit, paidAt: Date): Date {
    if (intent.reservedUntil === null) throw validationError('intentId', 'MISMATCH');
    return reservedUntilWhenPaid(
      { expiresAt: intent.expiresAt, reservedUntil: intent.reservedUntil },
      paidAt,
    );
  }

  // A user without a Wallet row is "no such user" to the operator, not a server error.
  private async lockWallet(tx: Db, userId: string): Promise<void> {
    try {
      await this.repo.lockWallet(tx, userId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }
}
