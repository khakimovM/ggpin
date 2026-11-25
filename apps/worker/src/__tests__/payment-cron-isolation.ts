import type { TestingModuleBuilder } from '@nestjs/testing';
import { TopupExpireProcessor } from '../bank-feed/topup-expire.processor';
import { OrderReconcileProcessor } from '../reconcile/orders/order-reconcile.processor';
import { PaymentReconcileProcessor } from '../reconcile/payment-reconcile.processor';

/**
 * For e2e suites that boot the whole WorkerModule for something else (queues, price sync): the
 * topup-expire sweep and the reconciliation are GLOBAL (every overdue request, every card of the
 * shared ggpin_test DB), and so is the order reconciler (every unresolved transfer and NEEDS_REVIEW
 * order, phase 5 S9), so their processors are replaced by plain objects and no Worker of theirs
 * runs there. Their schedulers may still register; the suites' cleanup removes those
 * queues (resetPriceSyncQueue).
 */
export function withoutPaymentCrons(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder
    .overrideProvider(TopupExpireProcessor)
    .useValue({})
    .overrideProvider(PaymentReconcileProcessor)
    .useValue({})
    .overrideProvider(OrderReconcileProcessor)
    .useValue({});
}
