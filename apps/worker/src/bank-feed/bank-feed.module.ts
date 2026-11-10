import { Module } from '@nestjs/common';
import { BankFeedEffects } from './bank-feed-effects';
import { BankFeedNotifier } from './bank-feed-notifier';
import { BankMessageProcessor } from './bank-message.processor';
import { BankMessageRepository } from './bank-message.repository';
import { CardLimitCheck } from './card-limit-check';
import { CardLimitProcessor } from './card-limit.processor';
import { CardLimitScheduler } from './card-limit-scheduler';
import { CardLimitsService } from './card-limits.service';
import { AutoCreditPauser } from './client/auto-credit-pauser';
import { BankChatAnomalyGuard } from './client/bank-chat-anomaly';
import { BankFeedAccountRepository } from './client/bank-feed-account.repository';
import { BANK_FEED_CLIENT } from './client/bank-feed-client';
import {
  BANK_FEED_LISTENER,
  bankFeedClientProvider,
  bankFeedListenerProvider,
} from './client/bank-feed-client.provider';
import { ListenerRepository } from './client/listener.repository';
import { SecurityPauseRepository } from './client/security-pause.repository';
import { IngestService } from './client/ingest.service';
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
// The bank-feed client of BANK_FEED_MODE (null when off) and its listener (S7) feed IngestService,
// as the daily re-scan does. Prisma, Redis, config and the queues come from global modules.
@Module({
  providers: [
    { provide: MATCHER_HOOKS, useValue: NO_MATCHER_HOOKS },
    { provide: FAIL_CLOSED_TIMING, useValue: DEFAULT_FAIL_CLOSED_TIMING },
    bankFeedClientProvider,
    IngestService,
    ListenerRepository,
    AutoCreditPauser,
    SecurityPauseRepository,
    BankChatAnomalyGuard,
    BankFeedAccountRepository,
    bankFeedListenerProvider,
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
  exports: [
    MatcherService,
    TopupCardsRepository,
    MatchWritesRepository,
    BankFeedNotifier,
    IngestService,
    BANK_FEED_CLIENT,
    BANK_FEED_LISTENER,
  ],
})
export class BankFeedModule {}
