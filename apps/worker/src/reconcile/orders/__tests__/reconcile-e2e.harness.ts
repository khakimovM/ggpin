import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUES, notifyJobId, walletCacheKey, type NotifyJob } from '@repo/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { RedisLockStore, type LockStore } from '../../../bank-feed/client/leader-lock';
import { WorkerConfigModule } from '../../../config/config.module';
import { OrderLock } from '../../../fulfillment/order-lock';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import {
  E2E_PAY_ADDRESSES,
  payRequest,
  rowsOf,
  type PayoutFixture,
} from '../../../ton/__tests__/ton-e2e.fixtures';
import {
  SIGN_AT_SEC,
  TEST_TIMING,
  TestSenderHooks,
  pinChain,
  useTonE2e,
} from '../../../ton/__tests__/ton-e2e.harness';
import { overrideTon } from '../../../ton/__tests__/ton-overrides';
import type { FakeSendScenario } from '../../../ton/fake-ton.gateway';
import type { TonChainWitness } from '../../../ton/ton-gateway';
import { TonConfirmService } from '../../../ton/ton-confirm.service';
import { TonSenderService } from '../../../ton/ton-sender.service';
import type { TonTiming } from '../../../ton/ton-tokens';
import type { PrismaHolder } from '../../../ton/ton-transfer.repository';
import { OrderReconcileModule } from '../order-reconcile.module';
import { OrderReconcileProcessor } from '../order-reconcile.processor';
import {
  OrderReconcileRepository,
  type PendingTransfer,
  type ReviewCursor,
} from '../order-reconcile.repository';
import { OrderReconcileScheduler } from '../order-reconcile.scheduler';
import { OrderReconcileService, type TickReport } from '../order-reconcile.service';
import { RECONCILE_ORDER_LOCK } from '../reconcile-order-lock';
import { ReviewResolver } from '../review-resolver';

// Real Postgres (the scratch `_test` database) + Redis DB 15, through the e2e lock: the TON module
// on the in-memory chain (FakeTonGateway, FULFILLMENT_DRY_RUN=true) and the order reconciler, with
// no BullMQ Worker (the processor and the scheduler are replaced; tests call the service the
// processor calls). Nothing reaches toncenter, testnet or mainnet.
//
// The shared test database keeps the NEEDS_REVIEW orders and unresolved transfers of earlier runs
// (append-only rows), more than one batch of them, so the reconciler's two LISTS are scoped to
// this run's orders here; everything else (the payout reads, the locks, the money helper, the
// effects) is the real code. order-reconcile-repository.e2e-spec.ts covers the real lists.

/** A lock store that always grants: only the database fence stands between two reconcilers. */
class GrantingLockStore implements LockStore {
  acquire(): Promise<boolean> {
    return Promise.resolve(true);
  }

  renew(): Promise<boolean> {
    return Promise.resolve(true);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}

/** The real repository, its two lists narrowed to the orders this run created. */
class ScopedReconcileRepository extends OrderReconcileRepository {
  constructor(
    private readonly holder: PrismaHolder,
    private readonly orders: ReadonlySet<string>,
  ) {
    super(holder);
  }

  override async pendingTransfers(limit: number): Promise<PendingTransfer[]> {
    const rows = await this.holder.client.tonTransfer.findMany({
      where: {
        purpose: 'ORDER',
        status: { in: ['SIGNED', 'BROADCAST'] },
        attempt: { orderId: { in: [...this.orders] } },
      },
      select: {
        id: true,
        network: true,
        walletAddress: true,
        attempt: { select: { orderId: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((r) => ({ ...r, orderId: r.attempt?.orderId ?? null }));
  }

  override reviewPage(_after: ReviewCursor | null, limit: number): Promise<ReviewCursor[]> {
    return this.holder.client.order.findMany({
      where: { status: 'NEEDS_REVIEW', id: { in: [...this.orders] } },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }
}

export interface Reconciler {
  readonly moduleRef: TestingModule;
  readonly service: OrderReconcileService;
  readonly resolver: ReviewResolver;
  readonly confirm: TonConfirmService;
  readonly sender: TonSenderService;
  readonly hooks: TestSenderHooks;
}

export interface ReconcilerOptions {
  /** On top of TEST_TIMING; by default a 1.5 s confirmation timeout (NEEDS_REVIEW fast). */
  readonly timing?: Partial<TonTiming>;
  /** The order lock always grants: two reconcilers meet only at the database fence. */
  readonly grantingLock?: boolean;
  readonly witnesses?: readonly TonChainWitness[];
}

export function useReconcileE2e() {
  const t = useTonE2e();
  const orders = new Set<string>();
  const modules: TestingModule[] = [];
  const state = {} as { redis: Redis; notify: Queue };

  beforeAll(() => {
    state.redis = new Redis(t.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: t.env.REDIS_URL } });
  });

  // The lists are scoped to the CURRENT test's orders: an earlier test's order (another
  // wallet) would show up as a foreign transfer in the counts.
  beforeEach(() => {
    orders.clear();
  });

  afterEach(async () => {
    for (const moduleRef of modules.splice(0)) await moduleRef.close();
  });

  afterAll(async () => {
    await state.notify.close();
    state.redis.disconnect();
  });

  async function boot(options: ReconcilerOptions = {}): Promise<Reconciler> {
    const hooks = new TestSenderHooks();
    let builder = overrideTon(
      Test.createTestingModule({
        imports: [
          WorkerConfigModule.forRoot(t.env),
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
        hooks,
        payAddresses: E2E_PAY_ADDRESSES,
        ...(options.witnesses === undefined ? {} : { witnesses: options.witnesses }),
      },
    )
      .overrideProvider(OrderReconcileProcessor)
      .useValue({})
      .overrideProvider(OrderReconcileScheduler)
      .useValue({})
      .overrideProvider(OrderReconcileRepository)
      .useFactory({
        factory: (prisma: PrismaService) => new ScopedReconcileRepository(prisma, orders),
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
    return {
      moduleRef,
      service: moduleRef.get(OrderReconcileService),
      resolver: moduleRef.get(ReviewResolver),
      confirm: moduleRef.get(TonConfirmService),
      sender: moduleRef.get(TonSenderService),
      hooks,
    };
  }

  async function order(): Promise<PayoutFixture> {
    const fixture = await t.order();
    // Every customer has a wallet row (the refund locks it first); the TON fixture has none.
    await t.db.wallet.create({ data: { userId: fixture.userId } });
    orders.add(fixture.orderId);
    return fixture;
  }

  /**
   * A payout that ends in NEEDS_REVIEW (CONFIRM_TIMEOUT) with its transfer still BROADCAST:
   * HOLD (the message lands when the test releases it) or LOSE (it never does; signed in the past
   * so the chain can prove the expiry once the test moves its clock past validUntil + margin).
   */
  async function timedOut(
    r: Reconciler,
    scenario: Extract<FakeSendScenario, 'HOLD' | 'LOSE'>,
  ): Promise<PayoutFixture & { readonly transferId: string }> {
    const fixture = await order();
    if (scenario === 'LOSE') pinChain(t.gateway, SIGN_AT_SEC);
    t.gateway.nextSend(scenario);
    const result = await r.sender.pay(payRequest(fixture));
    expect(result).toMatchObject({ status: 'REVIEW', transferStatus: 'BROADCAST' });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.order).toMatchObject({ status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' });
    return { ...fixture, transferId: rows.transfer?.id ?? '' };
  }

  return {
    t,
    orders,
    boot,
    order,
    timedOut,
    get redis() {
      return state.redis;
    },
    /** `lock:order:{id}` held by someone else (a fulfill run) while `fn` runs. */
    async whileLocked<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
      const run = await new OrderLock(new RedisLockStore(state.redis), 60_000).run(orderId, fn);
      if (run.busy) throw new Error('the order lock was taken already');
      return run.value;
    },
    async hasJob(job: NotifyJob): Promise<boolean> {
      return (await state.notify.getJob(notifyJobId(job))) !== undefined;
    },
    /** The notify jobs whose id starts with this prefix (an alert of one order, any episode). */
    async jobIdsLike(prefix: string): Promise<string[]> {
      const jobs = await state.notify.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
      return jobs.flatMap((job) => (job.id?.startsWith(prefix) === true ? [job.id] : []));
    },
    async cacheBalance(userId: string): Promise<void> {
      await state.redis.set(walletCacheKey(userId), '1', 'EX', 600);
    },
    async cached(userId: string): Promise<boolean> {
      return (await state.redis.exists(walletCacheKey(userId))) === 1;
    },
    /** The order's ledger entries (kind and amount) and its review audit rows. */
    async moneyOf(orderId: string) {
      const [ledger, audits, order] = await Promise.all([
        t.db.ledgerEntry.findMany({
          where: { refType: 'ORDER', refId: orderId },
          select: { kind: true, amountTiyin: true },
          orderBy: { createdAt: 'asc' },
        }),
        t.db.auditLog.findMany({
          where: { action: 'ORDER_REVIEW_RESOLVE', targetType: 'Order', targetId: orderId },
          select: { id: true, actorType: true, after: true },
        }),
        t.db.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true, statusReason: true, deliveredAt: true },
        }),
      ]);
      return { ledger, audits, order };
    },
  };
}

/** The counts of one step in a tick's report ({} when the step reported nothing). */
export function countsOf(report: TickReport, step: string): Readonly<Record<string, number>> {
  return report.steps.find((s) => s.step === step)?.counts ?? {};
}

export type ReconcileE2e = ReturnType<typeof useReconcileE2e>;
