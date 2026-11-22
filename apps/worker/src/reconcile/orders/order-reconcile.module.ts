import { Module } from '@nestjs/common';
import { AdaptersModule } from '../../adapters/adapters.module';
import { WalletCacheInvalidator } from '../../bank-feed/wallet-cache-invalidator';
import { FulfillmentModule } from '../../fulfillment/fulfillment.module';
import { TonModule } from '../../ton/ton.module';
import { AuditEffectsRepository } from './audit-effects.repository';
import { AuditEffectsStep } from './audit-effects.step';
import { HeldEvidence } from './held-evidence';
import { HeldSourcesRepository } from './held-sources.repository';
import { HeldSweepStep } from './held-sweep.step';
import { HeldWriter } from './held-writes';
import { LateFactsRepository } from './late-facts.repository';
import { LateFactsStep } from './late-facts.step';
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
import { WalletBlockedStep } from './wallet-blocked.step';

// The order reconciler (phase 5 S9, D-64): `reconcile:orders` every ORDER_RECONCILE_EVERY_MS on the
// `reconcile` queue. The TON module gives the chain look (TonConfirmService) and the hot wallet's
// address, never its signer or its lock; the adapters give the router (a HELD release, S9e, asks
// it which route the run would take: its cached health, never a send); the fulfillment core gives
// its enqueuer, the replay's resend and the abandon count (S9d), never its run or its payer;
// the late facts (S9f) read and write the chain only through the TON module's TonLateService;
// Prisma, Redis and the queues come from the worker's global modules. A later slice adds a step by
// providing it and listing it in RECONCILE_STEPS below, in its place in the fixed order (transfers,
// review, stale + stuck lease + notice resend S9d, held + blocked-wallet reminder S9e, late facts
// S9f, audit effects S9h).
@Module({
  imports: [TonModule, AdaptersModule, FulfillmentModule],
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
    HeldSourcesRepository,
    HeldEvidence,
    HeldWriter,
    HeldSweepStep,
    WalletBlockedStep,
    LateFactsRepository,
    LateFactsStep,
    AuditEffectsRepository,
    AuditEffectsStep,
    {
      provide: RECONCILE_STEPS,
      inject: [
        TransferSweepStep,
        ReviewSweepStep,
        StaleOrdersStep,
        OrderLockStuckStep,
        NoticeResendStep,
        HeldSweepStep,
        WalletBlockedStep,
        LateFactsStep,
        AuditEffectsStep,
      ],
      useFactory: (...steps: ReconcileStep[]): readonly ReconcileStep[] => steps,
    },
    OrderReconcileService,
    OrderReconcileScheduler,
    OrderReconcileProcessor,
  ],
})
export class OrderReconcileModule {}
