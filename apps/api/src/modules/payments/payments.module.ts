import { Module } from '@nestjs/common';
import { AMOUNT_RANDOM, cryptoAmountRandom } from './amount-allocator';
import { BankFeedHealth } from './bank-feed-health';
import { CardAdminRepository } from './card-admin.repository';
import { CardAdminService } from './card-admin.service';
import { CARD_LOCK_TIMING, DEFAULT_CARD_LOCK_TIMING } from './card-lock-timing';
import { CardPoolRepository } from './card-pool.repository';
import { CardPoolService } from './card-pool.service';
import { CardReservedAlert } from './card-reserved-alert';
import { PayLinkController } from './pay-link.controller';
import { PayViewService } from './pay-view.service';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentsAlerts } from './payments-alerts';
import { PaymentsController } from './payments.controller';
import { TopupCreateGuard } from './topup-create.guard';
import { TopupIntentsRepository } from './topup-intents.repository';
import { TopupIntentsService } from './topup-intents.service';
import { TopupLimits } from './topup-limits';

// P2P card top-ups, API side (docs/05): card choice, unique amounts, intents and the pay page.
// Crediting is the worker's (bank-feed). Prisma, Redis (FixedWindowCounter), Clock, config and
// the queues come from global modules. CardAdminService has no controller and no route. The owner
// CLI does NOT use this module: it registers its own providers (cli/ops-cli.module.ts). The
// service is exported here only so the API e2e suites can reach it.
@Module({
  controllers: [PaymentsController, PayLinkController],
  providers: [
    // The suffix random source is a provider so an e2e can pin it (the 50-parallel test uses 0).
    { provide: AMOUNT_RANDOM, useValue: cryptoAmountRandom },
    // Card-lock waits are a provider too: the 50-parallel e2e gives itself more room.
    { provide: CARD_LOCK_TIMING, useValue: DEFAULT_CARD_LOCK_TIMING },
    BankFeedHealth,
    CardAdminRepository,
    CardAdminService,
    CardPoolRepository,
    CardPoolService,
    CardReservedAlert,
    PayViewService,
    PaymentMethodsService,
    PaymentsAlerts,
    TopupCreateGuard,
    TopupIntentsRepository,
    TopupIntentsService,
    TopupLimits,
  ],
  exports: [CardAdminService],
})
export class PaymentsModule {}
