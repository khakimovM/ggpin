import { Module } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { BankFeedHealth } from '../payments/bank-feed-health';
import { UsersModule } from '../users/users.module';
import { BankfeedDownWatchdog } from './bankfeed-down.watchdog';
import { GrammyTgOutboxSender } from './grammy-tg-outbox.sender';
import { FulfillmentAlertRenderer } from './fulfillment-alert.renderer';
import { NotifySourcesRepository } from './notify-sources.repository';
import { NotifyConsumer } from './notify.consumer';
import { NOTIFY_QUEUE_NAME, NotifyWorker } from './notify.worker';
import { OrderNotifyProducer } from './order-notify.producer';
import { OrderNotifyRenderer } from './order-notify.renderer';
import { OwnerAlertRenderer } from './owner-alert.renderer';
import { TgOutboxConsumer } from './tg-outbox.consumer';
import { TgOutboxEnqueuer } from './tg-outbox.enqueuer';
import { TG_OUTBOX_SENDER } from './tg-outbox.sender';
import { TG_OUTBOX_QUEUE_NAME, TgOutboxWorker } from './tg-outbox.worker';
import { WatchdogRepository } from './watchdog.repository';
import { WorkerDownWatchdog } from './worker-down.watchdog';

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
    FulfillmentAlertRenderer,
    OrderNotifyRenderer,
    NotifyConsumer,
    NotifyWorker,
    // D-34 (12): one workerDown alert per worker outage, one queueStuck per stuck fulfill-order job.
    WatchdogRepository,
    WorkerDownWatchdog,
    // D-76 (4): one bankfeedDown alert per bankfeed container outage (its own state and key),
    // sent only once the top-up gate is closed. BankFeedHealth (the gate's own check) is our own
    // stateless instance: it needs only global Redis, config and clock, and payments exports
    // nothing, so notifications does not import PaymentsModule (no module cycle). It is the
    // SECOND instance (PaymentsModule has its own), so it must stay stateless: a cache or counter
    // added there would split between the two, and the gate and this watchdog could disagree.
    BankFeedHealth,
    BankfeedDownWatchdog,
    // Producer of the order notices (ORDER_ACCEPTED from the purchase).
    OrderNotifyProducer,
  ],
  exports: [TgOutboxEnqueuer, OrderNotifyProducer],
})
export class NotificationsModule {}
