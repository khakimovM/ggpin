import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient, type Tx } from '@repo/db';
import { QUEUES } from '@repo/shared';
import { Queue } from 'bullmq';
import { WorkerConfigModule } from '../../config/config.module';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import type { Env } from '../../config/env';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { RedisService } from '../../infra/redis/redis.service';
import { BankFeedModule } from '../bank-feed.module';
import { BankMessageProcessor } from '../bank-message.processor';
import { MATCHER_HOOKS, type MatcherHooks } from '../matcher-hooks';
import { MatcherService } from '../matcher.service';
import { BankFeedNotifier } from '../bank-feed-notifier';
import { CardLimitCheck } from '../card-limit-check';
import { CardLimitProcessor } from '../card-limit.processor';
import { cardLimitJobId } from '../card-limit-scheduler';
import {
  FAIL_CLOSED_TIMING,
  FailClosedService,
  type FailClosedTiming,
} from '../fail-closed.service';
import { HUMO_SENDER_ID, SENDER_ID, SUITE_HOLDER, retireSuiteCards } from './matcher-e2e.fixtures';

// Real ggpin_test Postgres + Redis DB 15 (`buildE2eEnv`), run through the e2e lock. Only the
// matcher's modules are booted: no BullMQ Worker is opened (the processor is replaced), so jobs
// of other suites are never consumed. The `notify` jobs the matcher adds are read back by id
// and removed at the end; nothing here reaches Telegram, Fragment, TON or an exchange.

export type HookFn<A extends unknown[]> = (...args: A) => Promise<void>;

/** Mutable hooks: a test swaps one in and `reset()` puts the no-ops back. */
export class TestHooks implements MatcherHooks {
  afterCardLockFn: HookFn<[Tx, string]> = () => Promise.resolve();
  beforeIntentLockFn: HookFn<[Tx, string]> = () => Promise.resolve();
  beforeCommitFn: HookFn<[Tx, string]> = () => Promise.resolve();
  settledByOtherFn: HookFn<[string]> = () => Promise.resolve();

  afterCardLock(tx: Tx, cardId: string): Promise<void> {
    return this.afterCardLockFn(tx, cardId);
  }

  beforeIntentLock(tx: Tx, intentId: string): Promise<void> {
    return this.beforeIntentLockFn(tx, intentId);
  }

  beforeCommit(tx: Tx, bankMessageId: string): Promise<void> {
    return this.beforeCommitFn(tx, bankMessageId);
  }

  settledByOther(bankMessageId: string): Promise<void> {
    return this.settledByOtherFn(bankMessageId);
  }

  reset(): void {
    this.afterCardLockFn = () => Promise.resolve();
    this.beforeIntentLockFn = () => Promise.resolve();
    this.beforeCommitFn = () => Promise.resolve();
    this.settledByOtherFn = () => Promise.resolve();
  }
}

export interface MatcherInstance {
  readonly moduleRef: TestingModule;
  readonly matcher: MatcherService;
  readonly hooks: TestHooks;
  /** The two job consumers, built by hand: no BullMQ Worker is opened in these suites. */
  readonly processor: BankMessageProcessor;
  readonly limitProcessor: CardLimitProcessor;
  readonly limitCheck: CardLimitCheck;
}

/** Short fail-closed waits for the suites (production: 3 tries of 10 s). */
export const TEST_FAIL_CLOSED_TIMING: FailClosedTiming = { lockWaitMs: 300, tries: 2, pauseMs: 50 };

export async function bootMatcher(env: Env, hooks: TestHooks): Promise<MatcherInstance> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      WorkerConfigModule.forRoot(env),
      PrismaModule,
      RedisModule,
      QueueModule,
      BankFeedModule,
    ],
  })
    .overrideProvider(BankMessageProcessor)
    .useValue({})
    .overrideProvider(CardLimitProcessor)
    .useValue({})
    .overrideProvider(MATCHER_HOOKS)
    .useValue(hooks)
    .overrideProvider(FAIL_CLOSED_TIMING)
    .useValue(TEST_FAIL_CLOSED_TIMING)
    .compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  const matcher = moduleRef.get(MatcherService);
  const limitCheck = moduleRef.get(CardLimitCheck);
  return {
    moduleRef,
    matcher,
    hooks,
    processor: new BankMessageProcessor(
      matcher,
      moduleRef.get(FailClosedService),
      moduleRef.get(BankFeedNotifier),
    ),
    limitProcessor: new CardLimitProcessor(limitCheck),
    limitCheck,
  };
}

/**
 * Removes every notify job this run produced (they would otherwise wait in DB 15 for the next
 * API suite that runs a notify consumer): ids read back by tests plus every job whose refId
 * names a row of this run (its bank messages, reviews, payments, cards).
 */
async function removeSuiteJobs(
  db: PrismaClient,
  queue: Queue,
  limitQueue: Queue,
  ids: Set<string>,
) {
  const messages = await db.bankMessage.findMany({
    where: { OR: [{ senderId: SENDER_ID }, { card: { holderName: SUITE_HOLDER } }] },
    select: { id: true },
  });
  const messageIds = messages.map((m) => m.id);
  const [reviews, payments, cards] = await Promise.all([
    db.paymentReview.findMany({
      where: { bankMessageId: { in: messageIds } },
      select: { id: true },
    }),
    db.payment.findMany({ where: { bankMessageId: { in: messageIds } }, select: { id: true } }),
    db.topupCard.findMany({ where: { holderName: SUITE_HOLDER }, select: { id: true } }),
  ]);
  const refs = new Set([...messageIds, ...reviews.map((r) => r.id), ...payments.map((p) => p.id)]);
  const cardIds = cards.map((c) => c.id);
  const jobs = await queue.getJobs([
    'waiting',
    'delayed',
    'paused',
    'prioritized',
    'completed',
    'failed',
  ]);
  for (const job of jobs) {
    const data: unknown = job.data;
    const ref =
      typeof data === 'object' && data !== null && 'refId' in data ? String(data.refId) : '';
    const mine = refs.has(ref) || cardIds.some((id) => ref === id || ref.startsWith(`${id}_`));
    if (mine || (job.id !== undefined && ids.has(job.id))) await job.remove();
  }
  for (const id of messageIds) await (await limitQueue.getJob(cardLimitJobId(id)))?.remove();
}

/** Shared state of one e2e file: a second matcher instance stands for a second worker process. */
export function useMatcherE2e() {
  // This run's synthetic senders: two different pinned bots, as the config demands (S9-I2).
  const env: Env = {
    ...buildE2eEnv(),
    BANK_FEED_HUMO_BOT_ID: HUMO_SENDER_ID,
    BANK_FEED_UZCARD_BOT_ID: SENDER_ID,
  };
  const state = {} as {
    db: PrismaClient;
    a: MatcherInstance;
    b: MatcherInstance;
    notify: Queue;
    limits: Queue;
    redis: RedisService;
  };
  const seenJobIds = new Set<string>();

  beforeAll(async () => {
    expect(env.FULFILLMENT_DRY_RUN).toBe(true);
    state.db = createPrismaClient(env.DATABASE_URL);
    await retireSuiteCards(state.db);
    state.a = await bootMatcher(env, new TestHooks());
    state.b = await bootMatcher(env, new TestHooks());
    state.redis = state.a.moduleRef.get(RedisService);
    state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: env.REDIS_URL } });
    state.limits = new Queue(QUEUES.CARD_LIMIT, { connection: { url: env.REDIS_URL } });
  });

  afterEach(() => {
    state.a.hooks.reset();
    state.b.hooks.reset();
  });

  afterAll(async () => {
    await removeSuiteJobs(state.db, state.notify, state.limits, seenJobIds);
    await state.notify.close();
    await state.limits.close();
    await state.a.moduleRef.close();
    await state.b.moduleRef.close();
    await retireSuiteCards(state.db);
    await state.db.$disconnect();
  });

  return {
    env,
    get db() {
      return state.db;
    },
    get a() {
      return state.a;
    },
    get b() {
      return state.b;
    },
    get redis() {
      return state.redis;
    },
    /** The notify job with this id, or undefined (and remembered for cleanup). */
    async notifyJob(jobId: string) {
      seenJobIds.add(jobId);
      return state.notify.getJob(jobId);
    },
    /** The card-limit job the effects queued for this message, or undefined. */
    limitJob(bankMessageId: string) {
      return state.limits.getJob(cardLimitJobId(bankMessageId));
    },
    /**
     * What the card-limit consumer does for this message (its job must have been queued), then
     * the job is removed so the next test starts clean.
     */
    async checkLimits(bankMessageId: string, instance: MatcherInstance = state.a) {
      const job = await state.limits.getJob(cardLimitJobId(bankMessageId));
      expect(job?.data).toEqual({ bankMessageId });
      const result = await instance.limitCheck.run(bankMessageId);
      await job?.remove();
      return result;
    },
    async ledger(userId: string) {
      return state.db.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    },
    async outcome(bankMessageId: string) {
      return state.db.bankMessageOutcome.findUnique({
        where: { bankMessageId },
        include: { review: true, payment: true },
      });
    },
  };
}

export type MatcherE2e = ReturnType<typeof useMatcherE2e>;
