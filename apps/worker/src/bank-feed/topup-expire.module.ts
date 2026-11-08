import { Module } from '@nestjs/common';
import { BankFeedModule } from './bank-feed.module';
import { OrphanRequeueService } from './orphan-requeue.service';
import { TopupExpireProcessor } from './topup-expire.processor';
import { TopupExpireScheduler } from './topup-expire.scheduler';
import { TopupExpireService } from './topup-expire.service';

// The every-minute request expiry and card-limit backstop (docs/05 §10). Its own module so the
// matcher suites, which boot BankFeedModule alone, never open this queue's Worker.
@Module({
  imports: [BankFeedModule],
  providers: [OrphanRequeueService, TopupExpireService, TopupExpireScheduler, TopupExpireProcessor],
})
export class TopupExpireModule {}
