import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { BankFeedModule } from './bank-feed/bank-feed.module';
import { TopupExpireModule } from './bank-feed/topup-expire.module';
import { WorkerConfigModule, type WorkerConfig } from './config/config.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';
import { buildLoggerParams } from './logging/logger-params';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { PricingSyncModule } from './pricing-sync/pricing-sync.module';
import { ReconcileModule } from './reconcile/reconcile.module';
import { RecipientsModule } from './recipients/recipients.module';
import { TonModule } from './ton/ton.module';

export interface WorkerModuleOptions {
  /** Where log lines go instead of stdout; tests capture output here. */
  readonly logDestination?: DestinationStream;
}

// Queue processors are added by their phases (docs/02-ARCHITECTURE.md#worker-modullari):
// price-sync in phase 3; bank-message, card-limit, topup-expire and payment-reconcile in phase 4;
// validate-recipient, fulfill-order and fragment-keepalive in phase 5.
// Every queue is registered already. BullWorkersShutdown (QueueModule) drains all processors
// before Prisma and Redis disconnect, whichever module they live in.
@Module({})
export class WorkerModule {
  // Config is passed in (parsed in main.ts) so booting never depends on ambient process.env.
  static register(config: WorkerConfig, options: WorkerModuleOptions = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        WorkerConfigModule.forRoot(config),
        LoggerModule.forRoot(buildLoggerParams(config, options.logDestination)),
        PrismaModule,
        RedisModule,
        QueueModule,
        HeartbeatModule,
        PricingSyncModule,
        BankFeedModule,
        TopupExpireModule,
        ReconcileModule,
        // Phase 5 S5: the hot wallet (dry run: a throw-away key on a fake chain, plan §8).
        TonModule,
        // Phase 5 S4: the fulfill-order consumer (dry run: simulators + the in-memory chain).
        FulfillmentModule,
        // Phase 5 S3b: the validate-recipient consumer (dry run: the simulators' lookups).
        RecipientsModule,
      ],
    };
  }
}
