import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import {
  QUEUE_JOB_DEFAULTS,
  QUEUES,
  queueStreamOptions,
  RECIPIENT_CHECK_JOB_NAME,
  RECIPIENT_CHECK_RETENTION_SEC,
  type RecipientCheckRequest,
} from '@repo/shared';
import { Queue, QueueEvents, type Job } from 'bullmq';
import { Logger as PinoLogger, LoggerModule } from 'nestjs-pino';
import type { FulfillmentAdapter } from '../../adapters/fulfillment-adapter';
import { SimulatorScript } from '../../adapters/simulator/simulator-script';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import { WorkerConfigModule } from '../../config/config.module';
import { buildAdapterRegistry } from '../../fulfillment/adapter-registry';
import { FULFILL_ADAPTERS } from '../../fulfillment/fulfill-tokens';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { QueueModule, workerBullOptions } from '../../infra/queue/queue.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { buildLoggerParams } from '../../logging/logger-params';
import { CaptureStream } from '../../logging/__tests__/capture-stream';
import { RECIPIENT_CHECK_TIMING, type RecipientCheckTiming } from '../recipient-check.config';
import { RecipientsModule } from '../recipients.module';
import { RecipientProducts, recipientCheckJobId } from './recipient-e2e.fixtures';

// Real Postgres (the scratch `_test` database) + Redis DB 15, through the e2e lock. The worker's
// infra modules + RecipientsModule with its REAL BullMQ Worker (limiter, concurrency) on the real
// `validate-recipient` queue; logs go through the worker's own Pino setup into a capture stream.
// The adapters are the dry-run simulators plus test stubs in one mutable map (FULFILL_ADAPTERS):
// nothing reaches fragment.com or any provider. Jobs are added exactly like the API adds them.

/** Short deadline so slow checks end quickly; same shape as production (wait - margin). */
export const E2E_TIMING: RecipientCheckTiming = {
  waitMs: 3_000,
  replyMarginMs: 300,
  minCallMs: 100,
  // Production sweep values: the sweep suite boots with its own.
  sweepEveryMs: 30_000,
  retentionMs: RECIPIENT_CHECK_RETENTION_SEC * 1_000,
};

const RETENTION = { age: RECIPIENT_CHECK_RETENTION_SEC, count: 1_000 } as const;

export interface HarnessOptions {
  readonly timing?: Partial<RecipientCheckTiming>;
  /** Extra adapters (by code) next to the simulators. */
  readonly adapters?: readonly FulfillmentAdapter[];
}

export function useRecipientE2e(options: HarnessOptions = {}) {
  const env = buildE2eEnv();
  const timing: RecipientCheckTiming = { ...E2E_TIMING, ...options.timing };
  const capture = new CaptureStream();
  const script = new SimulatorScript();
  const registry = new Map(buildAdapterRegistry(env, script));
  for (const adapter of options.adapters ?? []) registry.set(adapter.code, adapter);
  const jobIds = new Set<string>();
  const state = {} as {
    db: PrismaClient;
    moduleRef: TestingModule;
    queue: Queue;
    events: QueueEvents;
  };
  const products = new RecipientProducts(() => state.db);

  beforeAll(async () => {
    expect(env.FULFILLMENT_DRY_RUN).toBe(true);
    state.db = createPrismaClient(env.DATABASE_URL);
    const { connection } = workerBullOptions(env);
    // The API's producer: the queue's shared defaults, its own job options per add.
    state.queue = new Queue(QUEUES.VALIDATE_RECIPIENT, {
      connection,
      defaultJobOptions: QUEUE_JOB_DEFAULTS[QUEUES.VALIDATE_RECIPIENT],
      ...queueStreamOptions(QUEUES.VALIDATE_RECIPIENT),
    });
    state.events = new QueueEvents(QUEUES.VALIDATE_RECIPIENT, { connection });
    await state.events.waitUntilReady();
    state.moduleRef = await Test.createTestingModule({
      imports: [
        WorkerConfigModule.forRoot(env),
        LoggerModule.forRoot(buildLoggerParams({ ...env, LOG_LEVEL: 'info' }, capture)),
        PrismaModule,
        RedisModule,
        QueueModule,
        RecipientsModule,
      ],
    })
      .overrideProvider(RECIPIENT_CHECK_TIMING)
      .useValue(timing)
      .overrideProvider(FULFILL_ADAPTERS)
      .useValue(registry)
      .compile();
    state.moduleRef.useLogger(state.moduleRef.get(PinoLogger));
    await state.moduleRef.init();
  });

  afterAll(async () => {
    await state.moduleRef.close();
    for (const id of jobIds) await state.queue.remove(id);
    await state.events.close();
    await state.queue.close();
    await products.removeAll();
    await state.db.$disconnect();
  });

  /** Adds a check like the API does and returns the job. */
  async function add(
    request: unknown,
    extra: { readonly timestamp?: number; readonly jobId?: string } = {},
  ): Promise<Job> {
    const jobId = extra.jobId ?? recipientCheckJobId(request as RecipientCheckRequest, new Date());
    jobIds.add(jobId);
    return state.queue.add(RECIPIENT_CHECK_JOB_NAME, request, {
      jobId,
      removeOnComplete: RETENTION,
      removeOnFail: RETENTION,
      ...(extra.timestamp === undefined ? {} : { timestamp: extra.timestamp }),
    });
  }

  return {
    env,
    timing,
    capture,
    script,
    registry,
    products,
    get db() {
      return state.db;
    },
    get queue() {
      return state.queue;
    },
    get moduleRef() {
      return state.moduleRef;
    },
    get events() {
      return state.events;
    },
    add,
    /** Adds a check and waits for its answer (rejects when the job failed). */
    async ask(request: unknown, extra: { readonly timestamp?: number } = {}): Promise<unknown> {
      const job = await add(request, extra);
      return job.waitUntilFinished(state.events, timing.waitMs + 5_000);
    },
    /** The job as Redis holds it now (finished state, attempts). */
    async jobOf(id: string | undefined): Promise<Job | undefined> {
      return id === undefined ? undefined : state.queue.getJob(id);
    },
  };
}

export type RecipientE2e = ReturnType<typeof useRecipientE2e>;
