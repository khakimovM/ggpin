import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { ClockModule } from './common/clock/clock.module';
import type { RateLimit } from './common/http/http-limits';
import { HttpPipelineModule } from './common/http/http-pipeline.module';
import { buildLoggerParams } from './common/logging/logger-params';
import { AppConfigModule, type AppConfig } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { RecipientsModule } from './modules/recipients/recipients.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { UsersModule } from './modules/users/users.module';
import { WalletModule } from './modules/wallet/wallet.module';

export interface AppModuleOptions {
  /** Overrides the default per-IP limit; tests use a tiny window instead of 120 requests. */
  readonly rateLimit?: RateLimit;
  /** Where log lines go instead of stdout; tests capture output here. */
  readonly logDestination?: DestinationStream;
}

@Module({})
export class AppModule {
  // Config is passed in (parsed in main.ts) so booting never depends on ambient process.env.
  static register(config: AppConfig, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        LoggerModule.forRoot(buildLoggerParams(config, options.logDestination)),
        HttpPipelineModule.register(options.rateLimit),
        ClockModule,
        PrismaModule,
        RedisModule,
        QueueModule,
        HealthModule,
        UsersModule,
        WalletModule,
        PaymentsModule,
        PricingModule,
        CatalogModule,
        RecipientsModule,
        QuotesModule,
        // After HttpPipelineModule: its APP_GUARDs must run after the throttler.
        AuthModule,
        NotificationsModule,
        TelegramModule,
      ],
    };
  }
}
