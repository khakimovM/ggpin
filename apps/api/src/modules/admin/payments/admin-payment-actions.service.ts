import { Injectable } from '@nestjs/common';
import type {
  AdminCardChangeResponse,
  AdminCardLimitBody,
  AdminCardResumeBody,
  AdminPaymentReverseResponse,
  AdminReviewCreditBody,
  AdminReviewCreditResponse,
} from '@repo/shared';
import type { AdminActor } from '../../../common/admin/audit-actor';
import { CardAdminService, type CardChange } from '../../payments/card-admin.service';
import { CardPauseService } from '../../payments/card-pause.service';
import { ReviewCreditService } from '../../payments/review-credit.service';
import { ReviewEffects } from '../../payments/review-effects';
import { WalletAdminService } from '../../wallet/wallet-admin.service';
import { AdminWriteRepository, afterField } from '../write/admin-write.repository';
import { AdminPaymentsReadService } from './admin-payments-read.service';

const optionalAmount = (value: string | undefined) =>
  value === undefined ? {} : { confirmAmountTiyin: BigInt(value) };

/**
 * The owner CLI's P2P money and card services behind the panel's OWNER routes (docs/04
 * «To‘lovlar (P2P)», D-46, D-63 (3)): the same services, the same audit actions, with the acting
 * admin as the actor (re-read in each transaction, S2-6). `card:add` and the review closures
 * stay CLI-only (D-63 (6)).
 */
@Injectable()
export class AdminPaymentActionsService {
  constructor(
    private readonly credits: ReviewCreditService,
    private readonly wallet: WalletAdminService,
    private readonly cards: CardAdminService,
    private readonly pauses: CardPauseService,
    private readonly effects: ReviewEffects,
    private readonly reads: AdminPaymentsReadService,
    private readonly audits: AdminWriteRepository,
  ) {}

  /** REVIEW_CREDIT; the user's top-up notice and the owner's adminAction follow the commit. */
  async credit(
    actor: AdminActor,
    reviewId: string,
    body: AdminReviewCreditBody,
  ): Promise<AdminReviewCreditResponse> {
    const target =
      body.intentId !== undefined ? { intentId: body.intentId } : { userId: body.userId ?? '' };
    const done = await this.credits.credit({
      reviewId,
      target,
      reason: body.reason,
      actor,
      ...optionalAmount(body.confirmAmountTiyin),
      confirmOverride: body.confirmOverride,
      bankVerified: body.bankVerified,
    });
    return {
      reviewId: done.reviewId,
      paymentId: done.paymentId,
      userId: done.userId,
      intentId: done.intentId,
      amountTiyin: done.amountTiyin.toString(),
      auditId: done.auditId,
      applied: true,
    };
  }

  /** PAYMENT_REVERSE (TOPUP_REVERSAL); a negative balance freezes purchases (walletFrozen). */
  async reverse(
    actor: AdminActor,
    paymentId: string,
    body: { readonly reason: string; readonly confirmAmountTiyin?: string | undefined },
  ): Promise<AdminPaymentReverseResponse> {
    const change = await this.wallet.reverseTopup({
      paymentId,
      reason: body.reason,
      ...optionalAmount(body.confirmAmountTiyin),
      actor,
    });
    if (change.applied) await this.effects.adminAction(change.auditId);
    return {
      paymentId,
      userId: change.userId,
      ledgerEntryId: change.ledgerEntryId,
      balanceTiyin: change.balanceTiyin.toString(),
      frozen: change.frozen,
      auditId: change.auditId,
      applied: change.applied,
    };
  }

  async pause(actor: AdminActor, cardId: string, reason: string) {
    return this.cardAnswer(await this.pauses.pauseAutoCredit(cardId, reason, actor));
  }

  async resume(actor: AdminActor, cardId: string, body: AdminCardResumeBody) {
    const options = {
      confirmOverride: body.confirmOverride,
      confirmSecurityPause: body.confirmSecurityPause,
    };
    return this.cardAnswer(await this.pauses.resumeAutoCredit(cardId, body.reason, actor, options));
  }

  async limit(actor: AdminActor, cardId: string, body: AdminCardLimitBody) {
    const monthly = body.monthlyLimitTiyin;
    const limits = {
      limitTiyin: BigInt(body.receiveLimitTiyin),
      ...(monthly === undefined
        ? {}
        : { monthlyLimitTiyin: monthly === null ? null : BigInt(monthly) }),
    };
    return this.cardAnswer(await this.cards.setLimit(cardId, limits, body.reason, actor));
  }

  async retire(actor: AdminActor, cardId: string, reason: string, emergency: boolean) {
    return this.cardAnswer(await this.cards.retireCard(cardId, reason, actor, { emergency }));
  }

  // The card as the list shows it now; the requests an emergency retire cancelled come from the
  // change's own audit row (the service writes them there).
  private async cardAnswer(change: CardChange): Promise<AdminCardChangeResponse> {
    const row = change.auditId === null ? null : await this.audits.findAudit(change.auditId);
    const cancelled = row === null ? 0 : afterField(row, 'cancelledIntents');
    return {
      card: await this.reads.card(change.cardId),
      cancelledIntents: typeof cancelled === 'number' ? cancelled : 0,
      auditId: change.auditId,
      applied: change.applied,
    };
  }
}
