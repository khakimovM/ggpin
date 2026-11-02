import { Module } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { UsersModule } from '../users/users.module';
import { GrammyTgOutboxSender } from './grammy-tg-outbox.sender';
import { TgOutboxConsumer } from './tg-outbox.consumer';
import { TgOutboxEnqueuer } from './tg-outbox.enqueuer';
import { TG_OUTBOX_SENDER } from './tg-outbox.sender';
import { TG_OUTBOX_QUEUE_NAME, TgOutboxWorker } from './tg-outbox.worker';

// Redis, Clock and the queues come from global modules (RedisModule, ClockModule, QueueModule).
@Module({
  imports: [UsersModule],
  providers: [
    { provide: TG_OUTBOX_SENDER, useClass: GrammyTgOutboxSender },
    { provide: TG_OUTBOX_QUEUE_NAME, useValue: QUEUES.TG_OUTBOX },
    TgOutboxConsumer,
    TgOutboxWorker,
    TgOutboxEnqueuer,
  ],
  exports: [TgOutboxEnqueuer],
})
export class NotificationsModule {}
