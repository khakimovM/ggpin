import { Module } from '@nestjs/common';
import { BankFeedModule } from '../bank-feed/bank-feed.module';
import { BankTextPurgeRepository } from './bank-text-purge.repository';
import { BankTextPurgeService } from './bank-text-purge.service';
import { HistoryRescanService } from './history-rescan.service';
import { PaymentReconcileProcessor } from './payment-reconcile.processor';
import { PaymentReconcileScheduler } from './payment-reconcile.scheduler';
import { PaymentReconcileService } from './payment-reconcile.service';
import { ReconcileRepository } from './reconcile.repository';

// The daily payment reconciliation and raw bank-text purge (docs/05 §10). Its own module so the
// matcher suites, which boot BankFeedModule alone, never open this queue's Worker.
@Module({
  imports: [BankFeedModule],
  providers: [
    ReconcileRepository,
    BankTextPurgeRepository,
    BankTextPurgeService,
    HistoryRescanService,
    PaymentReconcileService,
    PaymentReconcileScheduler,
    PaymentReconcileProcessor,
  ],
})
export class ReconcileModule {}
