import { Module } from '@nestjs/common';
import { BankFeedEffects } from './bank-feed-effects';
import { BankFeedNotifier } from './bank-feed-notifier';
import { BankMessageProcessor } from './bank-message.processor';
import { BankMessageRepository } from './bank-message.repository';
import { CardLimitCheck } from './card-limit-check';
import { CardLimitProcessor } from './card-limit.processor';
import { CardLimitScheduler } from './card-limit-scheduler';
import { CardLimitsService } from './card-limits.service';
import { CreditDecider } from './credit-decider';
import {
  DEFAULT_FAIL_CLOSED_TIMING,
  FAIL_CLOSED_TIMING,
  FailClosedService,
} from './fail-closed.service';
import { MATCHER_HOOKS, NO_MATCHER_HOOKS } from './matcher-hooks';
import { MatcherService } from './matcher.service';
import { MatchWritesRepository } from './match-writes.repository';
import { MessageIntegrity } from './message-integrity';
import { TopupCardsRepository } from './topup-cards.repository';
import { WalletCacheInvalidator } from './wallet-cache-invalidator';

// P2P top-ups, worker side (docs/05 §6): matching stored bank messages and crediting wallets.
// The MTProto listener that stores the messages arrives in slice S7. Prisma, Redis, config and
// the queues come from global modules.
@Module({
  providers: [
    { provide: MATCHER_HOOKS, useValue: NO_MATCHER_HOOKS },
    { provide: FAIL_CLOSED_TIMING, useValue: DEFAULT_FAIL_CLOSED_TIMING },
    BankMessageRepository,
    MatchWritesRepository,
    TopupCardsRepository,
    MessageIntegrity,
    CreditDecider,
    CardLimitsService,
    BankFeedNotifier,
    WalletCacheInvalidator,
    CardLimitScheduler,
    CardLimitCheck,
    BankFeedEffects,
    MatcherService,
    FailClosedService,
    BankMessageProcessor,
    CardLimitProcessor,
  ],
  exports: [MatcherService],
})
export class BankFeedModule {}
