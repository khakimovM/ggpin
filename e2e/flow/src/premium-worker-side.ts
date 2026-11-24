import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUES } from '@repo/shared';
import { Queue } from 'bullmq';
import {
  SIMULATED_FRAGMENT_PAY_ADDRESS,
  SimulatorScript,
} from '../../../apps/worker/src/adapters/simulator/simulator-script';
import { buildE2eEnv } from '../../../apps/worker/src/config/__tests__/e2e-env';
import { WorkerConfigModule } from '../../../apps/worker/src/config/config.module';
import type { Env } from '../../../apps/worker/src/config/env';
import { SIMULATOR_SCRIPT } from '../../../apps/worker/src/fulfillment/adapter-registry';
import {
  FULFILL_TEST_TIMING,
  TestFulfillHooks,
  WALLET_BALANCE,
} from '../../../apps/worker/src/fulfillment/__tests__/fulfill-e2e.harness';
import { FulfillEnqueuer } from '../../../apps/worker/src/fulfillment/fulfill-enqueuer';
import { FulfillOrderProcessor } from '../../../apps/worker/src/fulfillment/fulfill-order.processor';
import { FulfillOrderService } from '../../../apps/worker/src/fulfillment/fulfill-order.service';
import type { RunOutcome } from '../../../apps/worker/src/fulfillment/fulfill-order.service';
import { FULFILL_HOOKS, FULFILL_TIMING } from '../../../apps/worker/src/fulfillment/fulfill-tokens';
import { FulfillmentModule } from '../../../apps/worker/src/fulfillment/fulfillment.module';
import { PrismaModule } from '../../../apps/worker/src/infra/prisma/prisma.module';
import { QueueModule } from '../../../apps/worker/src/infra/queue/queue.module';
import { RedisModule } from '../../../apps/worker/src/infra/redis/redis.module';
import { RecipientsModule } from '../../../apps/worker/src/recipients/recipients.module';
import { FakeTonGateway } from '../../../apps/worker/src/ton/fake-ton.gateway';
import {
  TEST_TIMING,
  TestSenderHooks,
  pinChain,
} from '../../../apps/worker/src/ton/__tests__/ton-e2e.harness';
import { overrideTon } from '../../../apps/worker/src/ton/__tests__/ton-overrides';
import { dryRunTonWallet, type TonWallet } from '../../../apps/worker/src/ton/ton-wallet';

// The worker side of the Premium order flow (phase 6 S6), in the same process as the API on the
// shared `_test` Postgres + Redis DB 15, from the worker's OWN env object (never the API's):
// - RecipientsModule with its REAL BullMQ consumer of `validate-recipient`: the API's
//   POST /recipients/validate is answered by the worker's lookup over the dry-run simulators;
// - FulfillmentModule (with TonModule) on the in-memory chain (FakeTonGateway, a throw-away
//   dry-run wallet, FULFILLMENT_DRY_RUN=true). Its BullMQ consumer is NOT opened: the
//   `fulfill-order` job the API queued is read back by id and handed to a FulfillOrderProcessor
//   built from the module's own service and enqueuer, exactly what the BullMQ worker would call.
// Nothing reaches fragment.com, toncenter, testnet or mainnet.

export class PremiumWorkerSide {
  private readonly touched = new Set<string>();

  private constructor(
    private readonly moduleRef: TestingModule,
    private readonly processor: FulfillOrderProcessor,
    private readonly fulfillQueue: Queue,
    readonly script: SimulatorScript,
    readonly gateway: FakeTonGateway,
    private readonly walletAddress: TonWallet['address'],
  ) {}

  static async boot(): Promise<PremiumWorkerSide> {
    const env: Env = buildE2eEnv();
    if (!env.FULFILLMENT_DRY_RUN) throw new Error('the flow e2e needs FULFILLMENT_DRY_RUN=true');
    const script = new SimulatorScript();
    script.setDefault('OK');
    const wallet = dryRunTonWallet('testnet');
    const gateway = new FakeTonGateway({ production: false, dryRun: true });
    gateway.registerWallet(wallet, WALLET_BALANCE);
    const moduleRef = await overrideTon(
      Test.createTestingModule({
        imports: [
          WorkerConfigModule.forRoot(env),
          PrismaModule,
          RedisModule,
          QueueModule,
          RecipientsModule,
          FulfillmentModule,
        ],
      }),
      {
        wallet,
        gateway,
        timing: TEST_TIMING,
        hooks: new TestSenderHooks(),
        payAddresses: new Set([SIMULATED_FRAGMENT_PAY_ADDRESS]),
      },
    )
      .overrideProvider(FULFILL_TIMING)
      .useValue(FULFILL_TEST_TIMING)
      .overrideProvider(FULFILL_HOOKS)
      .useValue(new TestFulfillHooks())
      .overrideProvider(SIMULATOR_SCRIPT)
      .useValue(script)
      .overrideProvider(FulfillOrderProcessor)
      .useValue({})
      .compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    const processor = new FulfillOrderProcessor(
      moduleRef.get(FulfillOrderService),
      moduleRef.get(FulfillEnqueuer),
    );
    const fulfillQueue = new Queue(QUEUES.FULFILL_ORDER, { connection: { url: env.REDIS_URL } });
    return new PremiumWorkerSide(
      moduleRef,
      processor,
      fulfillQueue,
      script,
      gateway,
      wallet.address,
    );
  }

  /** Whether the API queued this order's `fulfill-order` job (jobId = orderId). */
  async hasFulfillJob(orderId: string): Promise<boolean> {
    return (await this.fulfillQueue.getJob(orderId)) !== undefined;
  }

  /** What the BullMQ worker does with the queued job: the real processor runs the order. */
  async fulfil(orderId: string): Promise<RunOutcome> {
    const job = await this.fulfillQueue.getJob(orderId);
    if (job === undefined) throw new Error('no fulfill-order job for this order');
    this.touched.add(orderId);
    pinChain(this.gateway, 0);
    return this.processor.process(job);
  }

  /** Our wallet's executed transactions on the in-memory chain: payouts that really went out. */
  executedOnChain(): number {
    return this.gateway.transactionsOf(this.walletAddress).length;
  }

  /** Removes the fulfill-order jobs of this run and closes the worker. */
  async close(orderIds: Iterable<string>): Promise<void> {
    for (const id of [...this.touched, ...orderIds]) {
      await (await this.fulfillQueue.getJob(id))?.remove().catch(() => undefined);
    }
    await this.fulfillQueue.close();
    await this.moduleRef.close();
  }
}
