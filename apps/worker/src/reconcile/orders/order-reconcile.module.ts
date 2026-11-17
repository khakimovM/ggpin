import { Module } from '@nestjs/common';
import { WalletCacheInvalidator } from '../../bank-feed/wallet-cache-invalidator';
import { FulfillmentModule } from '../../fulfillment/fulfillment.module';
import { TonModule } from '../../ton/ton.module';
import { NoticeResendStep } from './notice-resend.step';
import { OrderLockKeys } from './order-lock-keys';
import { OrderLockStuckStep } from './order-lock-stuck.step';
import { OrderReconcileProcessor } from './order-reconcile.processor';
import { OrderReconcileRepository } from './order-reconcile.repository';
import { OrderReconcileScheduler } from './order-reconcile.scheduler';
import { OrderReconcileService } from './order-reconcile.service';
import { OrderSweepsRepository } from './order-sweeps.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import { reconcileOrderLockProvider } from './reconcile-order-lock';
import { RECONCILE_STEPS, type ReconcileStep } from './reconcile-step';
import { ReviewResolver } from './review-resolver';
import { ReviewSweepStep } from './review-sweep.step';
import { StaleOrdersStep } from './stale-orders.step';
import { TransferSweepStep } from './transfer-sweep.step';

// The order reconciler (phase 5 S9, D-64): `reconcile:orders` every ORDER_RECONCILE_EVERY_MS on the
// `reconcile` queue. The TON module gives the chain look (TonConfirmService) and the hot wallet's
// address, never its signer or its lock; the fulfillment core gives its enqueuer, the replay's
// resend and the abandon count (S9d), never its run or its payer; Prisma, Redis and the queues come
// from the worker's global modules. A later slice adds a step by providing it and listing it in
// RECONCILE_STEPS below, in its place in the fixed order (transfers, review, stale + stuck lease +
// notice resend S9d, held S9e, late facts S9f, audit effects S9h).
@Module({
  imports: [TonModule, FulfillmentModule],
  providers: [
    reconcileOrderLockProvider,
    WalletCacheInvalidator,
    OrderReconcileRepository,
    OrderSweepsRepository,
    OrderLockKeys,
    ReconcileNotifier,
    ReviewResolver,
    TransferSweepStep,
    ReviewSweepStep,
    StaleOrdersStep,
    OrderLockStuckStep,
    NoticeResendStep,
    {
      provide: RECONCILE_STEPS,
      inject: [
        TransferSweepStep,
        ReviewSweepStep,
        StaleOrdersStep,
        OrderLockStuckStep,
        NoticeResendStep,
      ],
      useFactory: (...steps: ReconcileStep[]): readonly ReconcileStep[] => steps,
    },
    OrderReconcileService,
    OrderReconcileScheduler,
    OrderReconcileProcessor,
  ],
})
export class OrderReconcileModule {}
