import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminBankMessageResponse,
  AdminCardListResponse,
  AdminCreditPreviewQuery,
  AdminCreditPreviewResponse,
  AdminIntentListQuery,
  AdminIntentListResponse,
  AdminPaymentListQuery,
  AdminPaymentListResponse,
  AdminReconcileQuery,
  AdminReconcileResponse,
  AdminReviewDetailResponse,
  AdminReviewListQuery,
  AdminReviewListResponse,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { paginated, type WithMeta } from '../../../common/http/with-meta';
import { ReviewCreditPreviewService } from '../../payments/review-credit-preview.service';
import { pageWindow, iso, type AdminReadView } from '../read/admin-read-view';
import {
  toAdminBankMessage,
  toAdminCard,
  toAdminIntentRow,
  toAdminPaymentRow,
  toAdminReviewDetail,
  toAdminReviewRow,
} from './admin-payments.mapper';
import { AdminPaymentsReadRepository } from './admin-payments-read.repository';
import { toAdminReconcileDay } from './admin-reconcile.mapper';

const DAY_SEC = 86_400;
type Page<T> = Promise<WithMeta<readonly T[]>>;

/** The admin's read side of incoming money (docs/04 «To‘lovlar (P2P)»). Nothing here writes. */
@Injectable()
export class AdminPaymentsReadService {
  constructor(
    private readonly repo: AdminPaymentsReadRepository,
    private readonly creditPreview: ReviewCreditPreviewService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async intents(query: AdminIntentListQuery): Page<AdminIntentListResponse[number]> {
    const { rows, total } = await this.repo.intents(query, pageWindow(query));
    return paginated(rows.map(toAdminIntentRow), { page: query.page, limit: query.limit, total });
  }

  async payments(query: AdminPaymentListQuery): Page<AdminPaymentListResponse[number]> {
    const { rows, total } = await this.repo.payments(query, pageWindow(query));
    return paginated(rows.map(toAdminPaymentRow), { page: query.page, limit: query.limit, total });
  }

  async reviews(query: AdminReviewListQuery): Page<AdminReviewListResponse[number]> {
    const { rows, total } = await this.repo.reviews(query, pageWindow(query));
    return paginated(rows.map(toAdminReviewRow), { page: query.page, limit: query.limit, total });
  }

  async review(id: string, view: AdminReadView): Promise<AdminReviewDetailResponse> {
    const review = await this.repo.review(id);
    if (review === null) throw new AppError('NOT_FOUND');
    return toAdminReviewDetail(review, view);
  }

  async bankMessage(id: string, view: AdminReadView): Promise<AdminBankMessageResponse> {
    const message = await this.repo.bankMessage(id);
    if (message === null) throw new AppError('NOT_FOUND');
    return toAdminBankMessage(message, view);
  }

  async cards(): Promise<AdminCardListResponse> {
    return (await this.repo.cards(this.clock.now())).map(toAdminCard);
  }

  async reconcile(query: AdminReconcileQuery): Page<AdminReconcileResponse[number]> {
    const { rows, total } = await this.repo.reconcileRuns(query, pageWindow(query));
    return paginated(rows.map(toAdminReconcileDay), {
      page: query.page,
      limit: query.limit,
      total,
    });
  }

  /** What the owner CLI's `review:credit` prints before it asks anything (OWNER, D-65 (6d)). */
  async creditPreviewOf(
    reviewId: string,
    query: AdminCreditPreviewQuery,
  ): Promise<AdminCreditPreviewResponse> {
    const target =
      query.intentId === undefined ? { userId: query.userId ?? '' } : { intentId: query.intentId };
    const preview = await this.creditPreview.preview(reviewId, target);
    const manual = preview.manualCreditsSinceRequest;
    return {
      amountTiyin: preview.amountTiyin.toString(),
      userId: preview.userId,
      blocked: preview.user.blocked,
      purchaseFrozen: preview.user.purchaseFrozen,
      accountAgeDays: Math.max(0, Math.floor(preview.user.accountAgeSec / DAY_SEC)),
      overLimit: preview.user.overLimit,
      overrideNeeded: preview.overrideNeeded,
      needsBankVerification: preview.needsBankVerification,
      manualCreditsSinceRequest: {
        adjust: { count: manual.adjust.count, sumTiyin: manual.adjust.sumTiyin.toString() },
        reviewCredit: {
          count: manual.reviewCredit.count,
          sumTiyin: manual.reviewCredit.sumTiyin.toString(),
        },
        since: iso(manual.since),
      },
    };
  }
}
