import { Body, HttpCode, Ip, Param, Post } from '@nestjs/common';
import type {
  AdminCardChangeResponse,
  AdminPaymentReverseResponse,
  AdminOtpAnswer,
  AdminPermission,
  AdminReviewCreditResponse,
} from '@repo/shared';
import type { AdminActor } from '../../../common/admin/audit-actor';
import { IdempotencyKey } from '../../payments/idempotency-key.decorator';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { RequestReceivedAt } from '../../../common/http/request-received';
import { adminResourceId } from '../read/admin-read-view';
import {
  AdminCardLimitBodyDto,
  AdminCardPauseBodyDto,
  AdminCardResumeBodyDto,
  AdminCardRetireBodyDto,
  AdminPaymentReverseBodyDto,
  AdminReviewCreditBodyDto,
} from '../write/admin-write.dto';
import { AdminWriteReplays } from '../write/admin-write.replays';
import { AdminWriteRunner } from '../write/admin-write.runner';
import { AdminPaymentActionsService } from './admin-payment-actions.service';

interface CardCall {
  readonly principal: AdminPrincipal;
  readonly ip: string;
  readonly receivedAtMs: number;
  readonly key: string;
  readonly id: string;
  readonly body: object;
  /** The code and the confirmation body it is bound to (retire always, a lowered limit). */
  readonly step?: (cardId: string) => {
    readonly otp: AdminOtpAnswer | undefined;
    readonly confirmation: () => unknown;
  };
}

// `POST /api/v1/admin/payments/*` (docs/04 «To‘lovlar (P2P)»): OWNER only; Idempotency-Key on
// every route. The code rules are the matrix's (credit always, reverse above the threshold,
// resume when a SECURITY pause is lifted), decided by the services under their locks.
@AdminController('payments')
export class AdminPaymentActionsController {
  constructor(
    private readonly runner: AdminWriteRunner,
    private readonly replays: AdminWriteReplays,
    private readonly actions: AdminPaymentActionsService,
  ) {}

  @AdminAction('payments.reviewCredit')
  @Post('reviews/:id/credit')
  @HttpCode(200)
  credit(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminReviewCreditBodyDto,
  ): Promise<AdminReviewCreditResponse> {
    const reviewId = adminResourceId(id);
    const target =
      body.intentId !== undefined ? { intentId: body.intentId } : { userId: body.userId };
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: reviewId, otp: body.otp },
        permission: 'payments.reviewCredit',
        confirmation: () => ({
          action: 'payments.reviewCredit',
          targetId: reviewId,
          amountTiyin: body.confirmAmountTiyin ?? '0',
          ...target,
          confirmOverride: body.confirmOverride,
          bankVerified: body.bankVerified,
        }),
        replay: (row) => this.replays.credit(row),
      },
      (actor) => this.actions.credit(actor, reviewId, body),
    );
  }

  @AdminAction('payments.reverse')
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminPaymentReverseBodyDto,
  ): Promise<AdminPaymentReverseResponse> {
    const paymentId = adminResourceId(id);
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: paymentId, otp: body.otp },
        permission: 'payments.reverse',
        confirmation: () => ({
          action: 'payments.reverse',
          targetId: paymentId,
          amountTiyin: body.confirmAmountTiyin ?? '0',
        }),
        replay: (row) => this.replays.reverse(row),
      },
      (actor) => this.actions.reverse(actor, paymentId, body),
    );
  }

  @AdminAction('cards.pause')
  @Post('cards/:id/pause')
  @HttpCode(200)
  pause(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminCardPauseBodyDto,
  ): Promise<AdminCardChangeResponse> {
    return this.card(
      { principal, ip, receivedAtMs, key, id, body },
      'cards.pause',
      (actor, cardId) => this.actions.pause(actor, cardId, body.reason),
    );
  }

  @AdminAction('cards.resume')
  @Post('cards/:id/resume')
  @HttpCode(200)
  resume(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminCardResumeBodyDto,
  ): Promise<AdminCardChangeResponse> {
    const cardId = adminResourceId(id);
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: cardId, otp: body.otp },
        permission: 'cards.resume',
        confirmation: () => ({
          action: 'cards.resume',
          targetId: cardId,
          confirmOverride: body.confirmOverride,
          confirmSecurityPause: body.confirmSecurityPause,
        }),
        replay: (row) => this.replays.card(row),
      },
      (actor) => this.actions.resume(actor, cardId, body),
    );
  }

  @AdminAction('cards.limit')
  @Post('cards/:id/limit')
  @HttpCode(200)
  limit(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminCardLimitBodyDto,
  ): Promise<AdminCardChangeResponse> {
    const step = (cardId: string) => ({
      otp: body.otp,
      confirmation: () => ({
        action: 'cards.limit',
        targetId: cardId,
        receiveLimitTiyin: body.receiveLimitTiyin,
        monthlyLimitTiyin: body.monthlyLimitTiyin,
      }),
    });
    return this.card(
      { principal, ip, receivedAtMs, key, id, body, step },
      'cards.limit',
      (actor, cardId) => this.actions.limit(actor, cardId, body),
    );
  }

  @AdminAction('cards.retire')
  @Post('cards/:id/retire')
  @HttpCode(200)
  retire(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminCardRetireBodyDto,
  ): Promise<AdminCardChangeResponse> {
    const step = (cardId: string) => ({
      otp: body.otp,
      confirmation: () => ({ action: 'cards.retire', targetId: cardId, emergency: body.emergency }),
    });
    return this.card(
      { principal, ip, receivedAtMs, key, id, body, step },
      'cards.retire',
      (actor, cardId) => this.actions.retire(actor, cardId, body.reason, body.emergency),
    );
  }

  private card(
    call: CardCall,
    permission: AdminPermission,
    work: (actor: AdminActor, cardId: string) => Promise<AdminCardChangeResponse>,
  ): Promise<AdminCardChangeResponse> {
    const cardId = adminResourceId(call.id);
    const { principal, ip, receivedAtMs, key, body } = call;
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: cardId, permission },
        ...(call.step === undefined ? {} : call.step(cardId)),
        replay: (row) => this.replays.card(row),
      },
      (actor) => work(actor, cardId),
    );
  }
}
