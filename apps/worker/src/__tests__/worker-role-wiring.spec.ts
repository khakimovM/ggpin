import { WorkerHost } from '@nestjs/bullmq';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  BANKFEED_PROCESS_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_KEY,
  type WorkerRole,
} from '@repo/shared';
import { FragmentKeepaliveScheduler } from '../adapters/fragment/fragment-keepalive.scheduler';
import { FRAGMENT_SESSION_KEY } from '../adapters/fragment/fragment-session.store';
import { BANK_FEED_CLIENT } from '../bank-feed/client/bank-feed-client';
import { BANK_FEED_LISTENER } from '../bank-feed/client/bank-feed-client.provider';
import { CardLimitScheduler } from '../bank-feed/card-limit-scheduler';
import { TopupExpireScheduler } from '../bank-feed/topup-expire.scheduler';
import { buildTestEnv } from '../config/__tests__/test-env';
import { FULFILL_ADAPTERS } from '../fulfillment/fulfill-tokens';
import { HEARTBEAT_KEYS } from '../heartbeat/heartbeat.service';
import { PriceSyncScheduler } from '../pricing-sync/price-sync.scheduler';
import { RecipientJobSweeper } from '../recipients/recipient-job-sweeper';
import { OrderReconcileScheduler } from '../reconcile/orders/order-reconcile.scheduler';
import { PaymentReconcileScheduler } from '../reconcile/payment-reconcile.scheduler';
import { TonBalanceMonitor } from '../ton/ton-balance.monitor';
import { TonSenderService } from '../ton/ton-sender.service';
import { roleQueues } from '../worker-role-modules';
import { WorkerModule } from '../worker.module';
import { withFakeInfra } from './fake-infra';

// D-76, plan §1.5: in each role the queue consumers in the real Nest graph are exactly the table's,
// and the other side's providers do not exist at all. Network edges faked, nothing started.

// @nestjs/bullmq keeps @Processor's options under this metadata key (bull.constants, not exported
// from the package root). A wrong key yields no names, so the equality checks below fail loudly.
const PROCESSOR_METADATA = 'bullmq:processor_metadata';

const FULFILLMENT_TABLE = [
  'fragment-keepalive',
  'fulfill-order',
  'price-sync',
  'reconcile',
  'validate-recipient',
];
const BANKFEED_TABLE = ['bank-message', 'card-limit', 'payment-reconcile', 'topup-expire'];
const TABLE: Record<WorkerRole, readonly string[]> = {
  fulfillment: FULFILLMENT_TABLE,
  bankfeed: BANKFEED_TABLE,
  all: [...FULFILLMENT_TABLE, ...BANKFEED_TABLE],
};

type Token = Parameters<TestingModule['get']>[0];

const FULFILLMENT_ONLY: readonly Token[] = [
  TonSenderService,
  FRAGMENT_SESSION_KEY,
  FULFILL_ADAPTERS,
  TonBalanceMonitor,
  RecipientJobSweeper,
  PriceSyncScheduler,
  FragmentKeepaliveScheduler,
  OrderReconcileScheduler,
];
const BANKFEED_ONLY: readonly Token[] = [
  CardLimitScheduler,
  BANK_FEED_CLIENT,
  BANK_FEED_LISTENER,
  TopupExpireScheduler,
  PaymentReconcileScheduler,
];

async function compile(role: WorkerRole): Promise<TestingModule> {
  const moduleRef = await withFakeInfra(
    Test.createTestingModule({
      imports: [WorkerModule.register(buildTestEnv({ WORKER_ROLE: role })), DiscoveryModule],
    }),
  ).compile();
  moduleRef.useLogger(false);
  return moduleRef;
}

/** Queue names of every WorkerHost class registered as a provider (overridden ones included). */
function consumerQueues(moduleRef: TestingModule): string[] {
  const names: string[] = [];
  for (const wrapper of moduleRef.get(DiscoveryService).getProviders()) {
    const token: unknown = wrapper.token;
    if (typeof token !== 'function' || !(token.prototype instanceof WorkerHost)) continue;
    const meta: unknown = Reflect.getMetadata(PROCESSOR_METADATA, token);
    const name =
      typeof meta === 'object' && meta !== null && 'name' in meta ? meta.name : undefined;
    names.push(typeof name === 'string' ? name : `<unnamed ${token.name}>`);
  }
  return names.sort();
}

// Registered at all, whatever the value (a dry run binds some tokens to undefined or null).
function has(moduleRef: TestingModule, token: Token): boolean {
  try {
    moduleRef.get(token, { strict: false });
    return true;
  } catch {
    return false;
  }
}

describe.each<WorkerRole>(['fulfillment', 'bankfeed', 'all'])('WORKER_ROLE=%s wiring', (role) => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await compile(role);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('runs exactly the consumers of the role table (and roleQueues says the same)', () => {
    expect(consumerQueues(moduleRef)).toEqual([...TABLE[role]].sort());
    expect([...roleQueues(role)].sort()).toEqual([...TABLE[role]].sort());
  });

  it('builds the fulfillment-only providers only where fulfillment runs', () => {
    const expected = role !== 'bankfeed';
    for (const token of FULFILLMENT_ONLY)
      expect([String(token), has(moduleRef, token)]).toEqual([String(token), expected]);
  });

  it('builds the bankfeed-only providers only where bankfeed runs', () => {
    const expected = role !== 'fulfillment';
    for (const token of BANKFEED_ONLY)
      expect([String(token), has(moduleRef, token)]).toEqual([String(token), expected]);
  });

  it('beats on the role process key(s)', () => {
    const keys = moduleRef.get<readonly string[]>(HEARTBEAT_KEYS, { strict: false });
    const expected = {
      fulfillment: [WORKER_HEARTBEAT_KEY],
      bankfeed: [BANKFEED_PROCESS_HEARTBEAT_KEY],
      all: [WORKER_HEARTBEAT_KEY, BANKFEED_PROCESS_HEARTBEAT_KEY],
    }[role];
    expect(keys).toEqual(expected);
  });
});
