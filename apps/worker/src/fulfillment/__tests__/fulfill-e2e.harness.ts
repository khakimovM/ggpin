import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { QUEUES, notifyJobId, parseMajor, type NotifyJob } from '@repo/shared';
import { Queue } from 'bullmq';
import {
  SimulatorScript,
  SIMULATED_FRAGMENT_PAY_ADDRESS,
} from '../../adapters/simulator/simulator-script';
import type { LockStore } from '../../bank-feed/client/leader-lock';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import { WorkerConfigModule } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { FakeTonGateway } from '../../ton/fake-ton.gateway';
import { TEST_TIMING, TestSenderHooks } from '../../ton/__tests__/ton-e2e.harness';
import { refIdsOf } from '../../ton/__tests__/ton-e2e.fixtures';
import { overrideTon } from '../../ton/__tests__/ton-overrides';
import type { TonWalletLock } from '../../ton/ton-lock';
import type { TonTiming } from '../../ton/ton-tokens';
import { dryRunTonWallet, type TonWallet } from '../../ton/ton-wallet';
import { abandonKey } from '../abandon-counter';
import { SIMULATOR_SCRIPT } from '../adapter-registry';
import { FulfillEnqueuer } from '../fulfill-enqueuer';
import { FulfillOrderProcessor } from '../fulfill-order.processor';
import { FulfillOrderService } from '../fulfill-order.service';
import {
  FULFILL_ADAPTERS,
  FULFILL_HOOKS,
  FULFILL_TIMING,
  ORDER_LOCK_STORE,
  TON_PAYER,
  type AdapterRegistry,
  type FulfillHooks,
  type FulfillTiming,
  type TonPayer,
} from '../fulfill-tokens';
import { FulfillmentModule } from '../fulfillment.module';
import { paidOrder, type OrderFixture, type OrderOptions } from './fulfill-e2e.fixtures';

// Real Postgres (the scratch `_test` database) + Redis DB 15, through the e2e lock. The worker's
// infra modules + FulfillmentModule (which imports TonModule), on the in-memory chain
// (FakeTonGateway, FULFILLMENT_DRY_RUN=true) and the simulators: nothing reaches toncenter,
// fragment.com, testnet or mainnet. The BullMQ consumer is replaced (no Worker is opened); tests
// call the service the processor calls. Each test gets a throw-away wallet and chain.

export const FULFILL_TEST_TIMING: FulfillTiming = {
  pollMs: 50,
  confirmTimeoutMs: 1_500,
  orderLockTtlMs: 10_000,
};
export const WALLET_BALANCE = parseMajor('TON', '100');

type Hook = (attemptId: string) => Promise<void>;

export class TestFulfillHooks implements FulfillHooks {
  afterSendingFn: Hook = () => Promise.resolve();

  afterSendingCommitted(attemptId: string): Promise<void> {
    return this.afterSendingFn(attemptId);
  }
}

/** A lock store that always grants: only the database fence stands between two runs. */
export class GrantingLockStore implements LockStore {
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

export interface FulfillInstance {
  readonly moduleRef: TestingModule;
  readonly service: FulfillOrderService;
  readonly enqueuer: FulfillEnqueuer;
  readonly tonHooks: TestSenderHooks;
  readonly hooks: TestFulfillHooks;
}

export interface BootOptions {
  readonly env?: Env;
  readonly timing?: Partial<TonTiming>;
  readonly fulfillTiming?: Partial<FulfillTiming>;
  readonly lockStore?: LockStore;
  /** Stands in for the TON module's pay() (results the chain cannot be scripted to give). */
  readonly payer?: TonPayer;
  /** Replaces the simulators (a stub adapter that misbehaves on purpose). */
  readonly adapters?: AdapterRegistry;
  readonly walletLock?: TonWalletLock;
  /** FRAGMENT_PAY_ADDRESSES of this instance (default: the simulated payee only). */
  readonly payAddresses?: ReadonlySet<string>;
}

export function useFulfillE2e() {
  const env = buildE2eEnv();
  const script = new SimulatorScript();
  const state = {} as {
    db: PrismaClient;
    notify: Queue;
    fulfillQueue: Queue;
    wallet: TonWallet;
    gateway: FakeTonGateway;
    main: FulfillInstance;
  };
  const instances: FulfillInstance[] = [];
  const orderIds = new Set<string>();

  async function boot(options: BootOptions = {}): Promise<FulfillInstance> {
    const tonHooks = new TestSenderHooks();
    const hooks = new TestFulfillHooks();
    let builder = overrideTon(
      Test.createTestingModule({
        imports: [
          WorkerConfigModule.forRoot(options.env ?? env),
          PrismaModule,
          RedisModule,
          QueueModule,
          FulfillmentModule,
        ],
      }),
      {
        wallet: state.wallet,
        gateway: state.gateway,
        timing: { ...TEST_TIMING, ...options.timing },
        hooks: tonHooks,
        payAddresses: options.payAddresses ?? new Set([SIMULATED_FRAGMENT_PAY_ADDRESS]),
        ...(options.walletLock === undefined ? {} : { walletLock: options.walletLock }),
      },
    )
      .overrideProvider(FULFILL_TIMING)
      .useValue({ ...FULFILL_TEST_TIMING, ...options.fulfillTiming })
      .overrideProvider(FULFILL_HOOKS)
      .useValue(hooks)
      .overrideProvider(SIMULATOR_SCRIPT)
      .useValue(script)
      .overrideProvider(FulfillOrderProcessor)
      .useValue({});
    if (options.payer !== undefined) {
      builder = builder.overrideProvider(TON_PAYER).useValue(options.payer);
    }
    if (options.adapters !== undefined) {
      builder = builder.overrideProvider(FULFILL_ADAPTERS).useValue(options.adapters);
    }
    if (options.lockStore !== undefined) {
      builder = builder.overrideProvider(ORDER_LOCK_STORE).useValue(options.lockStore);
    }
    const moduleRef = await builder.compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    const instance = {
      moduleRef,
      service: moduleRef.get(FulfillOrderService),
      enqueuer: moduleRef.get(FulfillEnqueuer),
      tonHooks,
      hooks,
    };
    instances.push(instance);
    return instance;
  }

  beforeAll(() => {
    expect(env.FULFILLMENT_DRY_RUN).toBe(true);
    state.db = createPrismaClient(env.DATABASE_URL);
    state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: env.REDIS_URL } });
    state.fulfillQueue = new Queue(QUEUES.FULFILL_ORDER, { connection: { url: env.REDIS_URL } });
  });

  beforeEach(async () => {
    script.setDefault('OK');
    state.wallet = dryRunTonWallet('testnet');
    state.gateway = new FakeTonGateway({ production: false, dryRun: true });
    state.gateway.registerWallet(state.wallet, WALLET_BALANCE);
    state.main = await boot();
  });

  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.moduleRef.close();
  });

  afterAll(async () => {
    const redis = await state.notify.client;
    for (const orderId of orderIds) await redis.del(abandonKey(orderId));
    for (const queue of [state.notify, state.fulfillQueue]) {
      const jobs = await queue.getJobs([
        'waiting',
        'delayed',
        'prioritized',
        'completed',
        'failed',
      ]);
      for (const job of jobs) {
        const mine = refIdsOf(job.data).some((ref) => orderIds.has(ref));
        const ownJob = job.id !== undefined && orderIds.has(job.id);
        if (mine || ownJob) await job.remove();
      }
      await queue.close();
    }
    await state.db.$disconnect();
  });

  return {
    env,
    script,
    get db() {
      return state.db;
    },
    get wallet() {
      return state.wallet;
    },
    get gateway() {
      return state.gateway;
    },
    get main() {
      return state.main;
    },
    get fulfillQueue() {
      return state.fulfillQueue;
    },
    /** Another worker process on the same wallet and chain (closed after the test). */
    boot,
    /** A worker process that died: its module is closed and thrown away. */
    async kill(instance: FulfillInstance): Promise<void> {
      const at = instances.indexOf(instance);
      if (at >= 0) instances.splice(at, 1);
      await instance.moduleRef.close();
    },
    async order(options: OrderOptions = {}): Promise<OrderFixture> {
      const fixture = await paidOrder(state.db, options);
      orderIds.add(fixture.orderId);
      return fixture;
    },
    /** Our wallet's executed transactions on the chain: how many payouts really went out. */
    executedOnChain(): number {
      return state.gateway.transactionsOf(state.wallet.address).length;
    },
    async hasJob(job: NotifyJob): Promise<boolean> {
      return (await state.notify.getJob(notifyJobId(job))) !== undefined;
    },
    async dropJob(job: NotifyJob): Promise<void> {
      await (await state.notify.getJob(notifyJobId(job)))?.remove();
    },
  };
}

export type FulfillE2e = ReturnType<typeof useFulfillE2e>;
