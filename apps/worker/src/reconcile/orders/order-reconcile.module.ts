import { Module } from '@nestjs/common';
import { WalletCacheInvalidator } from '../../bank-feed/wallet-cache-invalidator';
import { TonModule } from '../../ton/ton.module';
import { OrderReconcileProcessor } from './order-reconcile.processor';
import { OrderReconcileRepository } from './order-reconcile.repository';
import { OrderReconcileScheduler } from './order-reconcile.scheduler';
import { OrderReconcileService } from './order-reconcile.service';
import { ReconcileNotifier } from './reconcile-notifier';
import { reconcileOrderLockProvider } from './reconcile-order-lock';
import { RECONCILE_STEPS, type ReconcileStep } from './reconcile-step';
import { ReviewResolver } from './review-resolver';
import { ReviewSweepStep } from './review-sweep.step';
import { TransferSweepStep } from './transfer-sweep.step';

// The order reconciler (phase 5 S9, D-64): `reconcile:orders` every ORDER_RECONCILE_EVERY_MS on the
// `reconcile` queue. The TON module gives the chain look (TonConfirmService) and the hot wallet's
// address, never its signer or its lock; Prisma, Redis and the queues come from the worker's global
// modules. A later slice adds a step by providing it and listing it in RECONCILE_STEPS below, in
// its place in the fixed order (transfers, review, stale S9d, held S9e, late facts S9f, audit
// effects S9h). The fulfillment core is not imported here: nothing of it is needed yet (S9d needs
// its enqueuer).
@Module({
  imports: [TonModule],
  providers: [
    reconcileOrderLockProvider,
    WalletCacheInvalidator,
    OrderReconcileRepository,
    ReconcileNotifier,
    ReviewResolver,
    TransferSweepStep,
    ReviewSweepStep,
    {
      provide: RECONCILE_STEPS,
      inject: [TransferSweepStep, ReviewSweepStep],
      useFactory: (...steps: ReconcileStep[]): readonly ReconcileStep[] => steps,
    },
    OrderReconcileService,
    OrderReconcileScheduler,
    OrderReconcileProcessor,
  ],
})
export class OrderReconcileModule {}
