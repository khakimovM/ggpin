import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  CancelTopupIntentResponse,
  PayLinkResponse,
  PaymentMethodsResponse,
  TopupIntent,
  TopupIntentCreated,
} from '@repo/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import {
  CancelTopupIntentBodyDto,
  CreateTopupIntentBodyDto,
  IntentListQueryDto,
  IntentParamsDto,
  PayLinkBodyDto,
} from './dto/topup.dto';
import { IdempotencyKey } from './idempotency-key.decorator';
import { TopupCreateGuard } from './topup-create.guard';
import { PaymentMethodsService } from './payment-methods.service';
import { TopupIntentsService } from './topup-intents.service';

// Session routes of the P2P top-up (docs/04 "To‘lovlar"). Every answer is per user, so the
// default `no-store` stays. Cookie-session POSTs pass the global CsrfGuard (X-CSRF-Token +
// Origin, D-26); Mini App Bearer requests do not need it. `userId` only from the session.
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly intents: TopupIntentsService,
    private readonly paymentMethods: PaymentMethodsService,
  ) {}

  @Get('methods')
  methods(): Promise<PaymentMethodsResponse> {
    return this.paymentMethods.methods();
  }

  @Post('intents')
  @UseGuards(TopupCreateGuard)
  create(
    @CurrentUser('id') userId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreateTopupIntentBodyDto,
  ): Promise<TopupIntentCreated> {
    return this.intents.create(userId, idempotencyKey, body);
  }

  @Get('intents')
  list(
    @CurrentUser('id') userId: string,
    @Query() query: IntentListQueryDto,
  ): Promise<TopupIntent[]> {
    return this.intents.list(userId, query);
  }

  @Get('intents/:id')
  get(@CurrentUser('id') userId: string, @Param() params: IntentParamsDto): Promise<TopupIntent> {
    return this.intents.get(userId, params.id);
  }

  @Post('intents/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser('id') userId: string,
    @Param() params: IntentParamsDto,
    @Body() _body: CancelTopupIntentBodyDto,
  ): Promise<CancelTopupIntentResponse> {
    return this.intents.cancel(userId, params.id);
  }

  @Post('intents/:id/pay-link')
  @HttpCode(200)
  payLink(
    @CurrentUser('id') userId: string,
    @Param() params: IntentParamsDto,
    @Body() _body: PayLinkBodyDto,
  ): Promise<PayLinkResponse> {
    return this.intents.rotatePayLink(userId, params.id);
  }
}
