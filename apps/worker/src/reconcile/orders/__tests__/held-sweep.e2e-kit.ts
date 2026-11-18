import { Test, type TestingModule } from '@nestjs/testing';
import { transitionOrder, type Tx } from '@repo/db';
import {
  QUEUES,
  coreHoldNote,
  notifyJobId,
  walletCacheKey,
  type FulfillmentAlertKind,
  type OrderStatusReason,
} from '@repo/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { SIMULATED_FRAGMENT_PAY_ADDRESS } from '../../../adapters/simulator/simulator-script';
import { WorkerConfigModule } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { SIMULATOR_SCRIPT } from '../../../fulfillment/adapter-registry';
import { FulfillOrderProcessor } from '../../../fulfillment/fulfill-order.processor';
import { OrderLock } from '../../../fulfillment/order-lock';
import type { OrderOptions } from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import {
  GrantingLockStore,
  useFulfillE2e,
} from '../../../fulfillment/__tests__/fulfill-e2e.harness';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import { TEST_TIMING, TestSenderHooks } from '../../../ton/__tests__/ton-e2e.harness';
import { overrideTon } from '../../../ton/__tests__/ton-overrides';
import { TonSenderService } from '../../../ton/ton-sender.service';
import type { TonTiming } from '../../../ton/ton-tokens';
import { HeldSourcesRepository } from '../held-sources.repository';
import { HeldSweepStep } from '../held-sweep.step';
import { HeldWriter } from '../held-writes';
import { OrderReconcileModule } from '../order-reconcile.module';
import { OrderReconcileProcessor } from '../order-reconcile.processor';
import { OrderReconcileScheduler } from '../order-reconcile.scheduler';
import { RECONCILE_ORDER_LOCK } from '../reconcile-order-lock';
import { WalletBlockedStep } from '../wallet-blocked.step';
import { ReconcilerTraps, ScopedHeldSources } from './reconcile-e2e.fakes';

// The S9e steps (HELD release / refund, blocked-wallet reminder) on real Postgres (the scratch
// `_test` database) + Redis DB 15, through the e2e lock. The fulfill worker is the fulfillment
// harness's (`t.main`, its run called by hand); the reconciler is the real OrderReconcileModule
// (its wiring is what boots here: consumer, processor and scheduler replaced, the steps called by
// hand), its sender and wallet lock traps that must show zero calls after every test. The HELD
// lists are narrowed to this run's orders (ScopedHeldSources); the wallet-blocked list is narrowed
// by the throw-away wallet of each run. Order.createdAt and OrderEvent rows cannot be moved: the
// steps are handed a database clock (`nowMs`) as far after the stored times as a test needs.

export interface HeldReconciler {
  readonly moduleRef: TestingModule;
  readonly held: HeldSweepStep;
  readonly walletBlocked: WalletBlockedStep;
}

export interface HeldBootOptions {
  readonly env?: Env;
  readonly grantingLock?: boolean;
  readonly timing?: Partial<TonTiming>;
  /** Replaces the writer (a fault injected inside the refund transaction). */
  readonly writer?: (prisma: PrismaService) => HeldWriter;
}

export function useHeldE2e() {
  const t = useFulfillE2e();
  const orders = new Set<string>();
  const modules: TestingModule[] = [];
  const traps: ReconcilerTraps[] = [];
  const alertIds = new Set<string>();
  const state = {} as { redis: Redis; notify: Queue };

  beforeAll(() => {
    state.redis = new Redis(t.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: t.env.REDIS_URL } });
  });

  beforeEach(() => orders.clear());

  afterEach(async () => {
    const calls = traps.splice(0).map((trap) => trap.calls());
    for (const moduleRef of modules.splice(0)) await moduleRef.close();
    for (const call of calls) expect(call).toEqual({ pay: 0, walletLock: 0 });
  });

  afterAll(async () => {
    // Transfer-scoped reminders are not removed by the fulfillment harness (order ids only).
    for (const id of alertIds) await (await state.notify.getJob(id))?.remove();
    await state.notify.close();
    state.redis.disconnect();
  });

  async function boot(options: HeldBootOptions = {}): Promise<HeldReconciler> {
    const trap = new ReconcilerTraps();
    traps.push(trap);
    let builder = overrideTon(
      Test.createTestingModule({
        imports: [
          WorkerConfigModule.forRoot(options.env ?? t.env),
          PrismaModule,
          RedisModule,
          QueueModule,
          OrderReconcileModule,
        ],
      }),
      {
        wallet: t.wallet,
        gateway: t.gateway,
        timing: { ...TEST_TIMING, confirmTimeoutMs: 1_500, ...options.timing },
        hooks: new TestSenderHooks(),
        walletLock: trap.walletLock(),
        payAddresses: new Set([SIMULATED_FRAGMENT_PAY_ADDRESS]),
      },
    )
      .overrideProvider(TonSenderService)
      .useValue(trap.sender())
      .overrideProvider(FulfillOrderProcessor)
      .useValue({})
      .overrideProvider(OrderReconcileProcessor)
      .useValue({})
      .overrideProvider(OrderReconcileScheduler)
      .useValue({})
      .overrideProvider(SIMULATOR_SCRIPT)
      .useValue(t.script)
      .overrideProvider(HeldSourcesRepository)
      .useFactory({
        factory: (prisma: PrismaService) => new ScopedHeldSources(prisma, orders),
        inject: [PrismaService],
      });
    const { writer } = options;
    if (writer !== undefined) {
      builder = builder.overrideProvider(HeldWriter).useFactory({
        factory: (prisma: PrismaService) => writer(prisma),
        inject: [PrismaService],
      });
    }
    if (options.grantingLock === true) {
      builder = builder
        .overrideProvider(RECONCILE_ORDER_LOCK)
        .useValue(new OrderLock(new GrantingLockStore(), 60_000));
    }
    const moduleRef = await builder.compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    modules.push(moduleRef);
    return {
      moduleRef,
      held: moduleRef.get(HeldSweepStep),
      walletBlocked: moduleRef.get(WalletBlockedStep),
    };
  }

  async function dbNowMs(): Promise<number> {
    const [row] = await t.db.$queryRaw<{ ms: string }[]>`
      SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"`;
    return Number(row?.ms);
  }

  /** A PAID order of this run, scoped into the HELD lists. */
  async function order(options: OrderOptions = {}) {
    const fixture = await t.order(options);
    orders.add(fixture.orderId);
    return fixture;
  }

  /** PAID -> QUEUED -> PROCESSING -> HELD (system, as the run writes them), a core hold note. */
  async function holdAs(orderId: string, reason: OrderStatusReason, why = 'e2e'): Promise<void> {
    await t.db.$transaction(async (tx) => {
      const status = (await tx.order.findUniqueOrThrow({ where: { id: orderId } })).status;
      if (status === 'PAID') {
        await transitionOrder(tx, { orderId, from: 'PAID', to: 'QUEUED', actor: 'system' });
      }
      if (status === 'PAID' || status === 'QUEUED') {
        await transitionOrder(tx, { orderId, from: 'QUEUED', to: 'PROCESSING', actor: 'system' });
      }
      await transitionOrder(tx, {
        orderId,
        from: 'PROCESSING',
        to: 'HELD',
        actor: 'system',
        reason,
        note: coreHoldNote(reason, why),
      });
    });
  }

  /** The latest HELD event's time (database clock, ms): the base of every age a test hands in. */
  async function heldAtMs(orderId: string): Promise<number> {
    const held = await t.db.orderEvent.aggregate({
      where: { orderId, to: 'HELD' },
      _max: { createdAt: true },
    });
    const at = held._max.createdAt;
    if (at === null) throw new Error('no HELD event');
    return at.getTime();
  }

  /** Writes no guard trigger could (tests only): the replica role skips the triggers. */
  async function withTriggersOff(write: (tx: Tx) => Promise<unknown>): Promise<void> {
    await t.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await write(tx);
    });
  }

  function alertJob(alert: FulfillmentAlertKind, refId: string) {
    const job = { kind: 'OWNER_ALERT', alert, refId } as const;
    alertIds.add(notifyJobId(job));
    return job;
  }

  return {
    t,
    boot,
    dbNowMs,
    order,
    holdAs,
    heldAtMs,
    withTriggersOff,
    heldEvents(orderId: string): Promise<number> {
      return t.db.orderEvent.count({ where: { orderId, to: 'HELD' } });
    },
    get redis() {
      return state.redis;
    },
    async hasAlert(alert: FulfillmentAlertKind, refId: string): Promise<boolean> {
      return t.hasJob(alertJob(alert, refId));
    },
    async dropAlert(alert: FulfillmentAlertKind, refId: string): Promise<void> {
      await t.dropJob(alertJob(alert, refId));
    },
    async cacheBalance(userId: string): Promise<void> {
      await state.redis.set(walletCacheKey(userId), '1', 'EX', 600);
    },
    async cached(userId: string): Promise<boolean> {
      return (await state.redis.exists(walletCacheKey(userId))) === 1;
    },
    async fulfillJobState(orderId: string): Promise<string> {
      return (await t.fulfillQueue.getJob(orderId))?.getState() ?? 'none';
    },
    /** The reconciler's HELD -> QUEUED events of the order. */
    releasesOf(orderId: string): Promise<number> {
      return t.db.orderEvent.count({
        where: { orderId, from: 'HELD', to: 'QUEUED', note: { startsWith: 'reconcile release: ' } },
      });
    },
  };
}

export type HeldE2e = ReturnType<typeof useHeldE2e>;
