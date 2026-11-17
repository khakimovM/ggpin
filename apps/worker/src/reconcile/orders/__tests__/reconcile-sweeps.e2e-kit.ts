import { randomBytes } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUES, notifyJobId, type FulfillmentAlertKind } from '@repo/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { WalletCacheInvalidator } from '../../../bank-feed/wallet-cache-invalidator';
import { WorkerConfigModule } from '../../../config/config.module';
import { abandonKey } from '../../../fulfillment/abandon-counter';
import { FULFILL_ORDER_JOB_NAME } from '../../../fulfillment/fulfill-enqueuer';
import { FulfillOrderProcessor } from '../../../fulfillment/fulfill-order.processor';
import { FulfillmentModule } from '../../../fulfillment/fulfillment.module';
import { OrderLock, orderLockKey } from '../../../fulfillment/order-lock';
import type { OrderOptions } from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import {
  GrantingLockStore,
  useFulfillE2e,
} from '../../../fulfillment/__tests__/fulfill-e2e.harness';
import { SIMULATED_FRAGMENT_PAY_ADDRESS } from '../../../adapters/simulator/simulator-script';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import { TEST_TIMING, TestSenderHooks } from '../../../ton/__tests__/ton-e2e.harness';
import { overrideTon } from '../../../ton/__tests__/ton-overrides';
import { TonSenderService } from '../../../ton/ton-sender.service';
import { NoticeResendStep } from '../notice-resend.step';
import { OrderLockKeys } from '../order-lock-keys';
import { OrderLockStuckStep } from '../order-lock-stuck.step';
import { OrderReconcileRepository } from '../order-reconcile.repository';
import { OrderReconcileService } from '../order-reconcile.service';
import { OrderSweepsRepository } from '../order-sweeps.repository';
import { ReconcileNotifier } from '../reconcile-notifier';
import { RECONCILE_ORDER_LOCK, reconcileOrderLockProvider } from '../reconcile-order-lock';
import { StaleOrdersStep } from '../stale-orders.step';
import { ReconcilerTraps, ScopedSweepsRepository } from './reconcile-e2e.fakes';

// The S9d sweeps (job-less orders, stuck order leases, notice resend) on real Postgres (the
// scratch `_test` database) + Redis DB 15, through the e2e lock. The fulfill worker is the
// fulfillment e2e harness's (`t.main`: its run is called by hand, no BullMQ Worker); the
// reconciler is a module of its own with FulfillmentModule (its consumer replaced) and the three
// steps, whose sender and wallet lock are traps that must show zero calls after every test. The
// sweeps' lists are narrowed to this run's orders (the shared database keeps older ones).
// Order.createdAt is the database's and immutable, OrderEvent append-only: an order is made
// "unchanged for N minutes" by its creation event written N minutes back (as the API writes it),
// or a step is handed a later database clock. The narrowed reads are reconcile-e2e.fakes.ts's
// ScopedSweepsRepository (the reconciler harness uses the same one).

export interface Sweeps {
  readonly moduleRef: TestingModule;
  readonly stale: StaleOrdersStep;
  readonly lockStuck: OrderLockStuckStep;
  readonly notice: NoticeResendStep;
  /** A tick of these three steps, on the database clock read by the real service. */
  readonly service: OrderReconcileService;
}

export function useSweepsE2e() {
  const t = useFulfillE2e();
  const orders = new Set<string>();
  const modules: TestingModule[] = [];
  const traps: ReconcilerTraps[] = [];
  const keys = new Set<string>();
  const cleanups: (() => Promise<void>)[] = [];
  const state = {} as { redis: Redis; notify: Queue };

  beforeAll(() => {
    state.redis = new Redis(t.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: t.env.REDIS_URL } });
  });

  beforeEach(() => orders.clear());

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const key of keys) await state.redis.del(key);
    keys.clear();
    const calls = traps.splice(0).map((trap) => trap.calls());
    for (const moduleRef of modules.splice(0)) await moduleRef.close();
    for (const call of calls) expect(call).toEqual({ pay: 0, walletLock: 0 });
  });

  afterAll(async () => {
    await state.notify.close();
    state.redis.disconnect();
  });

  async function boot(options: { grantingLock?: boolean } = {}): Promise<Sweeps> {
    const trap = new ReconcilerTraps();
    traps.push(trap);
    let builder = overrideTon(
      Test.createTestingModule({
        imports: [
          WorkerConfigModule.forRoot(t.env),
          PrismaModule,
          RedisModule,
          QueueModule,
          FulfillmentModule,
        ],
        providers: [
          WalletCacheInvalidator,
          ReconcileNotifier,
          reconcileOrderLockProvider,
          OrderSweepsRepository,
          OrderLockKeys,
          StaleOrdersStep,
          OrderLockStuckStep,
          NoticeResendStep,
        ],
      }),
      {
        wallet: t.wallet,
        gateway: t.gateway,
        timing: TEST_TIMING,
        hooks: new TestSenderHooks(),
        walletLock: trap.walletLock(),
        payAddresses: new Set([SIMULATED_FRAGMENT_PAY_ADDRESS]),
      },
    )
      .overrideProvider(TonSenderService)
      .useValue(trap.sender())
      .overrideProvider(FulfillOrderProcessor)
      .useValue({})
      .overrideProvider(OrderSweepsRepository)
      .useFactory({
        factory: (prisma: PrismaService) => new ScopedSweepsRepository(prisma, orders),
        inject: [PrismaService],
      });
    if (options.grantingLock === true) {
      builder = builder
        .overrideProvider(RECONCILE_ORDER_LOCK)
        .useValue(new OrderLock(new GrantingLockStore(), 60_000));
    }
    const moduleRef = await builder.compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    modules.push(moduleRef);
    const stale = moduleRef.get(StaleOrdersStep);
    const lockStuck = moduleRef.get(OrderLockStuckStep);
    const notice = moduleRef.get(NoticeResendStep);
    const repository = new OrderReconcileRepository(moduleRef.get(PrismaService));
    const service = new OrderReconcileService(repository, [stale, lockStuck, notice]);
    return { moduleRef, stale, lockStuck, notice, service };
  }

  async function dbNowMs(): Promise<number> {
    const [row] = await t.db.$queryRaw<{ ms: string }[]>`
      SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"`;
    return Number(row?.ms);
  }

  return {
    t,
    boot,
    dbNowMs,
    get redis() {
      return state.redis;
    },
    /** A PAID order of this run (TON route), scoped into the sweeps' lists. */
    async order(options: OrderOptions = {}) {
      const fixture = await t.order(options);
      orders.add(fixture.orderId);
      return fixture;
    },
    /** The creation event (`null -> PAID`, as POST /orders writes it) `ageMs` back on the DB clock. */
    async createdAgo(orderId: string, ageMs: number): Promise<void> {
      const at = new Date((await dbNowMs()) - ageMs);
      await t.db.orderEvent.create({
        data: { orderId, from: null, to: 'PAID', actor: 'SYSTEM', createdAt: at },
      });
    },
    /** `lock:order:{id}` held by someone (no TTL: a poisoned lease); removed after the test. */
    async poisonLock(orderId: string): Promise<string> {
      const token = randomBytes(8).toString('hex');
      keys.add(orderLockKey(orderId));
      await state.redis.set(orderLockKey(orderId), token);
      return token;
    },
    lockValue(orderId: string): Promise<string | null> {
      return state.redis.get(orderLockKey(orderId));
    },
    async setAbandoned(orderId: string, count: number): Promise<void> {
      keys.add(abandonKey(orderId));
      await state.redis.set(abandonKey(orderId), String(count), 'PX', 600_000);
    },
    async fulfillJobState(orderId: string): Promise<string> {
      return (await t.fulfillQueue.getJob(orderId))?.getState() ?? 'none';
    },
    /** The order's fulfill-order job taken by a worker (state `active`) until the test ends. */
    async activeJob(orderId: string): Promise<void> {
      await t.fulfillQueue.add(FULFILL_ORDER_JOB_NAME, { orderId }, { jobId: orderId, lifo: true });
      const worker = new Worker(QUEUES.FULFILL_ORDER, null, {
        connection: { url: t.env.REDIS_URL, maxRetriesPerRequest: null },
        autorun: false,
      });
      const token = randomBytes(8).toString('hex');
      const job: Job | undefined = await worker.getNextJob(token, { block: false });
      cleanups.push(async () => {
        await job?.moveToCompleted('test done', token, false);
        await job?.remove();
        await worker.close();
      });
      if (job?.id !== orderId) throw new Error('another fulfill-order job was taken first');
      expect(await job.getState()).toBe('active');
    },
    async hasAlert(alert: FulfillmentAlertKind, refId: string): Promise<boolean> {
      return t.hasJob({ kind: 'OWNER_ALERT', alert, refId });
    },
    /** Notify job ids of this alert whose refId starts with the prefix (any episode). */
    async alertIdsLike(alert: FulfillmentAlertKind, refPrefix: string): Promise<string[]> {
      const prefix = notifyJobId({ kind: 'OWNER_ALERT', alert, refId: refPrefix });
      const jobs = await state.notify.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
      return jobs.flatMap((job) => (job.id?.startsWith(prefix) === true ? [job.id] : []));
    },
  };
}

export type SweepsE2e = ReturnType<typeof useSweepsE2e>;
