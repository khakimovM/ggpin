import { Module } from '@nestjs/common';
import { BankFeedModule } from './bank-feed.module';
import { CardDrainRepository } from './card-drain.repository';
import { CardDrainService } from './card-drain.service';
import { OrphanRequeueService } from './orphan-requeue.service';
import { TopupExpireProcessor } from './topup-expire.processor';
import { TopupExpireScheduler } from './topup-expire.scheduler';
import { TopupExpireService } from './topup-expire.service';

// The every-minute request expiry, card-limit backstop and DRAINING -> RETIRED sweep (docs/05
// §2, §10). Its own module so the matcher suites, which boot BankFeedModule alone, never open
// this queue's Worker.
@Module({
  imports: [BankFeedModule],
  providers: [
    CardDrainRepository,
    CardDrainService,
    OrphanRequeueService,
    TopupExpireService,
    TopupExpireScheduler,
    TopupExpireProcessor,
  ],
})
export class TopupExpireModule {}
