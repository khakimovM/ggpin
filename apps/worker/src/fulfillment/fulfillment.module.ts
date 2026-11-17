import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { RedisLockStore } from '../bank-feed/client/leader-lock';
import { WalletCacheInvalidator } from '../bank-feed/wallet-cache-invalidator';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { RedisService } from '../infra/redis/redis.service';
import { TonSenderService } from '../ton/ton-sender.service';
import { TonModule } from '../ton/ton.module';
import {
  ABANDON_COUNTER,
  ABANDON_PEEK,
  RedisAbandonCounter,
  abandonPeekOf,
  type AbandonCounter,
} from './abandon-counter';
import { AttemptsRepository } from './attempts.repository';
import { FulfillEnqueuer } from './fulfill-enqueuer';
import { FreshAttempt } from './fulfill-fresh';
import { FulfillOrderProcessor } from './fulfill-order.processor';
import { FulfillOrderService } from './fulfill-order.service';
import { FulfillReplay } from './fulfill-replay';
import { FulfillReviewer } from './fulfill-review';
import { FulfillSettler } from './fulfill-settle';
import { FulfillSupplierRunner } from './fulfill-supplier.runner';
import { FulfillTonRunner } from './fulfill-ton.runner';
import {
  FULFILL_HOOKS,
  FULFILL_TIMING,
  NO_FULFILL_HOOKS,
  ORDER_LOCK_STORE,
  TON_PAYER,
  fulfillTimingOf,
  type TonPayer,
} from './fulfill-tokens';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { OperatorReleaseRepository } from './operator-release.repository';
import { OrderStateRepository } from './order-state.repository';

// The fulfillment core (phase 5 S4): the `fulfill-order` consumer and its steps. The TON payout is
// the TON module's (S5), reached through TON_PAYER only; Prisma, Redis and the queues come from the
// worker's global modules.
@Module({
  // The adapters, their scenario script and the router: one shared set (AdaptersModule, S3b).
  imports: [TonModule, AdaptersModule],
  providers: [
    {
      provide: FULFILL_TIMING,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => fulfillTimingOf(config),
    },
    { provide: FULFILL_HOOKS, useValue: NO_FULFILL_HOOKS },
    {
      provide: TON_PAYER,
      inject: [TonSenderService],
      useFactory: (sender: TonSenderService): TonPayer => ({
        pay: (request) => sender.pay(request),
      }),
    },
    {
      provide: ORDER_LOCK_STORE,
      inject: [RedisService],
      useFactory: (redis: RedisService) => new RedisLockStore(redis.client),
    },
    {
      provide: ABANDON_COUNTER,
      inject: [RedisService],
      useFactory: (redis: RedisService) => new RedisAbandonCounter(redis.client),
    },
    {
      provide: ABANDON_PEEK,
      inject: [ABANDON_COUNTER],
      useFactory: (counter: AbandonCounter) => abandonPeekOf(counter),
    },
    WalletCacheInvalidator,
    OrderStateRepository,
    AttemptsRepository,
    OperatorReleaseRepository,
    FulfillmentNotifier,
    FulfillReviewer,
    FulfillTonRunner,
    FulfillSupplierRunner,
    FreshAttempt,
    FulfillReplay,
    FulfillSettler,
    FulfillOrderService,
    FulfillEnqueuer,
    FulfillOrderProcessor,
  ],
  // The order reconciler (phase 5 S9d) uses the enqueuer, the replay's resend and the abandon
  // count read only (ABANDON_PEEK, no bump). It never injects the run, the settle or the counter
  // itself (order-reconcile-static.spec.ts), and the payer is never exported: it never fulfills.
  exports: [FulfillOrderService, FulfillEnqueuer, FulfillReplay, ABANDON_PEEK],
})
export class FulfillmentModule {}
