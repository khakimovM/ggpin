import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { QUEUES, notifyJobId, parseMajor } from '@repo/shared';
import { Queue } from 'bullmq';
import type { LockStore } from '../../bank-feed/client/leader-lock';
import { WorkerConfigModule } from '../../config/config.module';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import type { Env } from '../../config/env';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { FakeTonGateway } from '../fake-ton.gateway';
import { TonBalanceMonitor } from '../ton-balance.monitor';
import { TonConfirmService } from '../ton-confirm.service';
import type { TonChainWitness } from '../ton-gateway';
import { TonWalletLock } from '../ton-lock';
import { noticeJob, type TonNotice } from '../ton-notices';
import { TonSenderService } from '../ton-sender.service';
import {
  TON_EXPIRY_WITNESSES,
  TON_GATEWAY,
  TON_PAY_ADDRESSES,
  TON_SENDER_HOOKS,
  TON_TIMING,
  TON_WALLET,
  TON_WALLET_LOCK,
  TON_WALLET_LOCK_KEY,
  type TonSenderHooks,
  type TonTiming,
} from '../ton-tokens';
import { TonTransferRepository } from '../ton-transfer.repository';
import { dryRunTonWallet, type TonWallet } from '../ton-wallet';
import { TonModule } from '../ton.module';
import {
  E2E_PAY_ADDRESSES,
  addAttempt,
  processingOrder,
  refIdsOf,
  type PayoutFixture,
} from './ton-e2e.fixtures';

// Real Postgres (the scratch `_test` database) + Redis DB 15, run through the e2e lock. Only the
// TON module and the worker's infra modules are booted, on the in-memory chain (FakeTonGateway,
// FULFILLMENT_DRY_RUN=true): nothing here reaches toncenter, testnet or mainnet. Every test gets a
// throw-away wallet of its own (the database allows one unresolved message per wallet), and the
// `notify` jobs of this run (refId = one of its orders, transfers or snapshots) are removed after it.

// maxClockSkewSec is wide here only so a test can sign at SIGN_AT_SEC (the database clock is then
// already past valid_until + the margin); the expiry gap is short so the two observations of an
// EXPIRED (D-60 (2)) fit in a test, on a chain clock that ticks.
export const TEST_TIMING: TonTiming = {
  pollMs: 50,
  destGraceSec: 20,
  confirmTimeoutMs: 20_000,
  lockTtlMs: 120_000,
  maxClockSkewSec: 300,
  expiryGapSec: 1,
};

export const WALLET_BALANCE = parseMajor('TON', '100');

/**
 * Chain clock offsets (seconds from now). Signing at SIGN_AT_SEC (inside the 300 s clock-skew
 * window) puts valid_until = now - 140 s, so the database clock is already past valid_until + the
 * 60 s margin (the guard of migration 10 accepts EXPIRED); moving the chain to PAST_VALID_SEC makes
 * the chain prove it (chain time > valid_until + margin, seqno unchanged, message not found).
 */
export const SIGN_AT_SEC = -200;
export const PAST_VALID_SEC = -50;

/** Sets the chain clock to now + offset; it ticks on with the wall clock from there. */
export function pinChain(gateway: FakeTonGateway, offsetSec: number): void {
  gateway.setChainTime(Math.floor(Date.now() / 1_000) + offsetSec, true);
}

type Hook = (transferId: string) => Promise<void>;

/** Death points: a hook that throws stands for a worker that died right there. */
export class TestSenderHooks implements TonSenderHooks {
  afterStoredFn: Hook = () => Promise.resolve();
  afterBroadcastFn: Hook = () => Promise.resolve();

  afterStored(transferId: string): Promise<void> {
    return this.afterStoredFn(transferId);
  }

  afterBroadcast(transferId: string): Promise<void> {
    return this.afterBroadcastFn(transferId);
  }
}

/** A lock that always grants: only the database fence is left between two senders. */
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

export interface TonInstance {
  readonly moduleRef: TestingModule;
  readonly sender: TonSenderService;
  readonly confirm: TonConfirmService;
  readonly transfers: TonTransferRepository;
  readonly monitor: TonBalanceMonitor;
  readonly hooks: TestSenderHooks;
}

export interface BootOptions {
  readonly wallet: TonWallet;
  readonly gateway: FakeTonGateway;
  readonly env?: Env;
  readonly timing?: Partial<TonTiming>;
  /** The Redis wallet lock always grants: two senders meet only at the database fence. */
  readonly noRedisLock?: boolean;
  /** TON_EXPIRY_WITNESSES (none unless a test gives some, as in production today). */
  readonly witnesses?: readonly TonChainWitness[];
}

/** One worker process: the TON module on the given wallet and chain. */
export async function bootTon(env: Env, options: BootOptions): Promise<TonInstance> {
  const hooks = new TestSenderHooks();
  let builder = Test.createTestingModule({
    imports: [
      WorkerConfigModule.forRoot(options.env ?? env),
      PrismaModule,
      RedisModule,
      QueueModule,
      TonModule,
    ],
  })
    .overrideProvider(TON_WALLET)
    .useValue(options.wallet)
    .overrideProvider(TON_GATEWAY)
    .useValue(options.gateway)
    .overrideProvider(TON_TIMING)
    .useValue({ ...TEST_TIMING, ...options.timing })
    .overrideProvider(TON_SENDER_HOOKS)
    .useValue(hooks)
    .overrideProvider(TON_PAY_ADDRESSES)
    .useValue(E2E_PAY_ADDRESSES)
    .overrideProvider(TON_EXPIRY_WITNESSES)
    .useValue(options.witnesses ?? []);
  if (options.noRedisLock === true) {
    builder = builder
      .overrideProvider(TON_WALLET_LOCK)
      .useValue(new TonWalletLock(new GrantingLockStore(), TON_WALLET_LOCK_KEY, 120_000));
  }
  const moduleRef = await builder.compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  return {
    moduleRef,
    sender: moduleRef.get(TonSenderService),
    confirm: moduleRef.get(TonConfirmService),
    transfers: moduleRef.get(TonTransferRepository),
    monitor: moduleRef.get(TonBalanceMonitor),
    hooks,
  };
}

/** Shared state of one e2e file; a fresh wallet, chain and module per test. */
export function useTonE2e() {
  const env = buildE2eEnv();
  const state = {} as {
    db: PrismaClient;
    notify: Queue;
    wallet: TonWallet;
    gateway: FakeTonGateway;
    ton: TonInstance;
  };
  const extra: TonInstance[] = [];
  const orderIds = new Set<string>();
  const walletAddresses = new Set<string>();
  const jobIds = new Set<string>();

  function newWallet(): TonWallet {
    const wallet = dryRunTonWallet('testnet');
    walletAddresses.add(wallet.rawAddress);
    return wallet;
  }

  beforeAll(() => {
    expect(env.FULFILLMENT_DRY_RUN).toBe(true);
    state.db = createPrismaClient(env.DATABASE_URL);
    state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: env.REDIS_URL } });
  });

  beforeEach(async () => {
    state.wallet = newWallet();
    state.gateway = new FakeTonGateway({ production: false, dryRun: true });
    state.gateway.registerWallet(state.wallet, WALLET_BALANCE);
    state.ton = await bootTon(env, { wallet: state.wallet, gateway: state.gateway });
  });

  afterEach(async () => {
    for (const instance of extra.splice(0)) await instance.moduleRef.close();
    await state.ton.moduleRef.close();
  });

  afterAll(async () => {
    const addresses = [...walletAddresses];
    const [transfers, snapshots] = await Promise.all([
      state.db.tonTransfer.findMany({
        where: { walletAddress: { in: addresses } },
        select: { id: true },
      }),
      state.db.walletSnapshot.findMany({
        where: { address: { in: addresses } },
        select: { id: true },
      }),
    ]);
    const refs = new Set([
      ...orderIds,
      ...transfers.map((r) => r.id),
      ...snapshots.map((r) => r.id),
    ]);
    const jobs = await state.notify.getJobs([
      'waiting',
      'delayed',
      'paused',
      'prioritized',
      'completed',
      'failed',
    ]);
    for (const job of jobs) {
      const mine =
        refIdsOf(job.data).some((ref) => refs.has(ref)) ||
        (job.id !== undefined && jobIds.has(job.id));
      if (mine) await job.remove();
    }
    await state.notify.close();
    await state.db.$disconnect();
  });

  return {
    env,
    get db() {
      return state.db;
    },
    get wallet() {
      return state.wallet;
    },
    get gateway() {
      return state.gateway;
    },
    get ton() {
      return state.ton;
    },
    newWallet,
    /** Another worker process (closed after the test). */
    async boot(options: BootOptions): Promise<TonInstance> {
      const instance = await bootTon(env, options);
      extra.push(instance);
      return instance;
    },
    async order(): Promise<PayoutFixture> {
      const fixture = await processingOrder(state.db);
      orderIds.add(fixture.orderId);
      return fixture;
    },
    /** The next attempt of the same order (what the fulfillment core creates after EXPIRED). */
    async attempt(fixture: PayoutFixture, attemptNo: number): Promise<PayoutFixture> {
      return { ...fixture, attemptId: await addAttempt(state.db, fixture.orderId, attemptNo) };
    },
    /** Each notice must have been queued, under its stable job id. */
    async expectJobs(notices: readonly TonNotice[]): Promise<void> {
      for (const notice of notices) {
        const id = notifyJobId(noticeJob(notice));
        jobIds.add(id);
        const found = (await state.notify.getJob(id)) !== undefined;
        expect({ id, found }).toEqual({ id, found: true });
      }
    },
    /** Removes these notices' jobs, as if their enqueue had been lost (Redis away). */
    async dropJobs(notices: readonly TonNotice[]): Promise<void> {
      for (const notice of notices) {
        await (await state.notify.getJob(notifyJobId(noticeJob(notice))))?.remove();
      }
    },
    async expectNoJob(notice: TonNotice): Promise<void> {
      const id = notifyJobId(noticeJob(notice));
      jobIds.add(id);
      expect(await state.notify.getJob(id)).toBeUndefined();
    },
  };
}

export type TonE2e = ReturnType<typeof useTonE2e>;
