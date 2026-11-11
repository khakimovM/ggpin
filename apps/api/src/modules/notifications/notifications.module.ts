import { Module } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { UsersModule } from '../users/users.module';
import { GrammyTgOutboxSender } from './grammy-tg-outbox.sender';
import { NotifySourcesRepository } from './notify-sources.repository';
import { NotifyConsumer } from './notify.consumer';
import { NOTIFY_QUEUE_NAME, NotifyWorker } from './notify.worker';
import { OwnerAlertRenderer } from './owner-alert.renderer';
import { TgOutboxConsumer } from './tg-outbox.consumer';
import { TgOutboxEnqueuer } from './tg-outbox.enqueuer';
import { TG_OUTBOX_SENDER } from './tg-outbox.sender';
import { TG_OUTBOX_QUEUE_NAME, TgOutboxWorker } from './tg-outbox.worker';

// Prisma, Redis, Clock, config and the queues come from global modules (PrismaModule,
// RedisModule, ClockModule, AppConfigModule, QueueModule). `notify` (worker -> API) is rendered
// here and handed to `tg-outbox`, which sends it.
@Module({
  imports: [UsersModule],
  providers: [
    { provide: TG_OUTBOX_SENDER, useClass: GrammyTgOutboxSender },
    { provide: TG_OUTBOX_QUEUE_NAME, useValue: QUEUES.TG_OUTBOX },
    { provide: NOTIFY_QUEUE_NAME, useValue: QUEUES.NOTIFY },
    TgOutboxConsumer,
    TgOutboxWorker,
    TgOutboxEnqueuer,
    NotifySourcesRepository,
    OwnerAlertRenderer,
    NotifyConsumer,
    NotifyWorker,
  ],
  exports: [TgOutboxEnqueuer],
})
export class NotificationsModule {}
