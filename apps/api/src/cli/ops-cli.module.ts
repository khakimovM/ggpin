import { Module, type DynamicModule } from '@nestjs/common';
import { OwnerOtpIssuer } from '../common/admin/owner-otp/owner-otp.issuer';
import { OwnerOtpVerifier } from '../common/admin/owner-otp/owner-otp.verifier';
import { ClockModule } from '../common/clock/clock.module';
import { AppConfigModule, type AppConfig } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { QueueModule } from '../infra/queue/queue.module';
import { RedisModule } from '../infra/redis/redis.module';
import { CardAdminRepository } from '../modules/payments/card-admin.repository';
import { CardAdminService } from '../modules/payments/card-admin.service';
import { CARD_LOCK_TIMING, DEFAULT_CARD_LOCK_TIMING } from '../modules/payments/card-lock-timing';
import { CardPauseRepository } from '../modules/payments/card-pause.repository';
import { CardPauseService } from '../modules/payments/card-pause.service';
import { TgOutboxEnqueuer } from '../modules/notifications/tg-outbox.enqueuer';
import { CardPoolRepository } from '../modules/payments/card-pool.repository';
import { PaymentsAlerts } from '../modules/payments/payments-alerts';
import { ReviewChecksRepository } from '../modules/payments/review-checks.repository';
import { ReviewCreditPreviewService } from '../modules/payments/review-credit-preview.service';
import { ReviewCreditService } from '../modules/payments/review-credit.service';
import { ReviewEffects } from '../modules/payments/review-effects';
import { ReviewRepository } from '../modules/payments/review.repository';
import { ReviewService } from '../modules/payments/review.service';
import { WalletAdminService } from '../modules/wallet/wallet-admin.service';
import { WalletCache } from '../modules/wallet/wallet-cache';
import { WalletFrozenAlert } from '../modules/wallet/wallet-frozen-alert';
import { WalletRepository } from '../modules/wallet/wallet.repository';
import { WalletUnfreezeService } from '../modules/wallet/wallet-unfreeze.service';
import { CardListing } from './card-listing';

/**
 * The owner CLI's own module graph (not AppModule): config, clock, Prisma, Redis (wallet cache)
 * and the producer-only queues (notify; tg-outbox for the owner's one-time code, D-46), plus the
 * owner services. No HTTP pipeline, no bot, no controllers, no queue consumers: running a
 * command never starts a server or takes jobs (the API's tg-outbox worker sends the code).
 * Worker secrets are not part of the API env (the API config rejects them), so none is here.
 */
@Module({})
export class OpsCliModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: OpsCliModule,
      imports: [
        AppConfigModule.forRoot(config),
        ClockModule,
        PrismaModule,
        RedisModule,
        QueueModule,
      ],
      providers: [
        { provide: CARD_LOCK_TIMING, useValue: DEFAULT_CARD_LOCK_TIMING },
        CardAdminRepository,
        CardAdminService,
        CardListing,
        CardPauseRepository,
        CardPauseService,
        CardPoolRepository,
        OwnerOtpIssuer,
        OwnerOtpVerifier,
        PaymentsAlerts,
        ReviewChecksRepository,
        ReviewCreditPreviewService,
        ReviewCreditService,
        ReviewEffects,
        ReviewRepository,
        ReviewService,
        TgOutboxEnqueuer,
        WalletAdminService,
        WalletCache,
        WalletFrozenAlert,
        WalletRepository,
        WalletUnfreezeService,
      ],
    };
  }
}
