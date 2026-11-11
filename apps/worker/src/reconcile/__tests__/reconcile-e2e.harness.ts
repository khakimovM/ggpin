import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUES, bankMessageJobId } from '@repo/shared';
import { Queue } from 'bullmq';
import { WorkerConfigModule } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { BankFeedModule } from '../../bank-feed/bank-feed.module';
import { BankFeedNotifier } from '../../bank-feed/bank-feed-notifier';
import { BankMessageProcessor } from '../../bank-feed/bank-message.processor';
import { CardLimitProcessor } from '../../bank-feed/card-limit.processor';
import { BANK_FEED_CLIENT } from '../../bank-feed/client/bank-feed-client';
import { FakeBankFeedClient } from '../../bank-feed/client/fake-bank-feed.client';
import { IngestService } from '../../bank-feed/client/ingest.service';
import { TopupExpireModule } from '../../bank-feed/topup-expire.module';
import { TopupExpireProcessor } from '../../bank-feed/topup-expire.processor';
import { TopupExpireScheduler } from '../../bank-feed/topup-expire.scheduler';
import { TopupExpireService } from '../../bank-feed/topup-expire.service';
import { PaymentReconcileProcessor } from '../payment-reconcile.processor';
import { PaymentReconcileScheduler } from '../payment-reconcile.scheduler';
import { PaymentReconcileService } from '../payment-reconcile.service';
import { ReconcileModule } from '../reconcile.module';
import { ReconcileRepository } from '../reconcile.repository';

// The S9 modules on the real ggpin_test Postgres + Redis DB 15 (next to `useMatcherE2e`, which
// owns the rows, the matcher and the notify-job cleanup). No BullMQ Worker is opened (every
// processor is replaced) and the boot schedulers are off: the suites call the services and
// read the queued jobs, so nothing is consumed and nothing reaches Telegram or a bank. The
// bank-feed client is the in-memory fake.

export interface ReconcileWorker {
  readonly moduleRef: TestingModule;
  readonly client: FakeBankFeedClient;
  readonly expire: TopupExpireService;
  readonly reconcile: PaymentReconcileService;
  readonly repo: ReconcileRepository;
  readonly ingest: IngestService;
  readonly notifier: BankFeedNotifier;
  readonly config: Env;
  /** The `bank-message` queue (a producer only), to read and remove the jobs ingest added. */
  readonly bankMessages: Queue;
  /** Removes the `bank-message` jobs of these rows; call before the module closes. */
  removeBankMessageJobs(ids: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export async function bootReconcileWorker(env: Env): Promise<ReconcileWorker> {
  const client = new FakeBankFeedClient();
  const moduleRef = await Test.createTestingModule({
    imports: [
      WorkerConfigModule.forRoot(env),
      PrismaModule,
      RedisModule,
      QueueModule,
      BankFeedModule,
      TopupExpireModule,
      ReconcileModule,
    ],
  })
    .overrideProvider(BANK_FEED_CLIENT)
    .useValue(client)
    .overrideProvider(BankMessageProcessor)
    .useValue({})
    .overrideProvider(CardLimitProcessor)
    .useValue({})
    .overrideProvider(TopupExpireProcessor)
    .useValue({})
    .overrideProvider(PaymentReconcileProcessor)
    .useValue({})
    .overrideProvider(TopupExpireScheduler)
    .useValue({})
    .overrideProvider(PaymentReconcileScheduler)
    .useValue({})
    .compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  const bankMessages = new Queue(QUEUES.BANK_MESSAGE, { connection: { url: env.REDIS_URL } });
  return {
    moduleRef,
    client,
    expire: moduleRef.get(TopupExpireService),
    reconcile: moduleRef.get(PaymentReconcileService),
    repo: moduleRef.get(ReconcileRepository),
    ingest: moduleRef.get(IngestService),
    notifier: moduleRef.get(BankFeedNotifier),
    config: env,
    bankMessages,
    async removeBankMessageJobs(ids) {
      for (const id of ids) await (await bankMessages.getJob(bankMessageJobId(id)))?.remove();
    },
    async close() {
      await bankMessages.close();
      await moduleRef.close();
    },
  };
}
