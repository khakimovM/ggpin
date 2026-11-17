import { Get, Param, Query } from '@nestjs/common';
import type {
  AdminBankMessageResponse,
  AdminCardListResponse,
  AdminCreditPreviewResponse,
  AdminIntentListResponse,
  AdminPaymentListResponse,
  AdminReconcileResponse,
  AdminReviewDetailResponse,
  AdminReviewListResponse,
} from '@repo/shared';
import type { WithMeta } from '../../../common/http/with-meta';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { withAdminFieldErrors } from '../read/admin-domain-error';
import {
  AdminCreditPreviewQueryDto,
  AdminIntentListQueryDto,
  AdminPaymentListQueryDto,
  AdminReconcileQueryDto,
  AdminReviewListQueryDto,
} from '../read/admin-read.dto';
import { adminReadView, adminResourceId } from '../read/admin-read-view';
import { AdminPaymentsReadService } from './admin-payments-read.service';

type Page<T> = Promise<WithMeta<readonly T[]>>;

// `GET /api/v1/admin/payments/*` (docs/04 «To‘lovlar (P2P)»). Every role reads; the raw bank
// text, the balance after it and the channel are OWNER's only (the mapper decides from the
// view); the credit preview is OWNER's (AdminGuard: `payments.creditPreview`).
@AdminController('payments')
export class AdminPaymentsController {
  constructor(private readonly payments: AdminPaymentsReadService) {}

  @AdminAction('payments.read')
  @Get('intents')
  intents(@Query() query: AdminIntentListQueryDto): Page<AdminIntentListResponse[number]> {
    return this.payments.intents(query);
  }

  @AdminAction('payments.read')
  @Get()
  list(@Query() query: AdminPaymentListQueryDto): Page<AdminPaymentListResponse[number]> {
    return this.payments.payments(query);
  }

  @AdminAction('payments.read')
  @Get('reviews')
  reviews(@Query() query: AdminReviewListQueryDto): Page<AdminReviewListResponse[number]> {
    return this.payments.reviews(query);
  }

  @AdminAction('payments.read')
  @Get('reviews/:id')
  review(
    @CurrentAdmin() principal: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminReviewDetailResponse> {
    return this.payments.review(adminResourceId(id), adminReadView(principal.admin.role));
  }

  @AdminAction('payments.creditPreview')
  @Get('reviews/:id/credit-preview')
  creditPreview(
    @Param('id') id: string,
    @Query() query: AdminCreditPreviewQueryDto,
  ): Promise<AdminCreditPreviewResponse> {
    return withAdminFieldErrors(() => this.payments.creditPreviewOf(adminResourceId(id), query));
  }

  @AdminAction('payments.read')
  @Get('bank-messages/:id')
  bankMessage(
    @CurrentAdmin() principal: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminBankMessageResponse> {
    return this.payments.bankMessage(adminResourceId(id), adminReadView(principal.admin.role));
  }

  @AdminAction('payments.read')
  @Get('cards')
  cards(): Promise<AdminCardListResponse> {
    return this.payments.cards();
  }

  @AdminAction('payments.read')
  @Get('reconcile')
  reconcile(@Query() query: AdminReconcileQueryDto): Page<AdminReconcileResponse[number]> {
    return this.payments.reconcile(query);
  }
}
