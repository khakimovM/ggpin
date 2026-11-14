import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import {
  QUEUE_JOB_DEFAULTS,
  QUEUES,
  RECIPIENT_CHECK_JOB_NAME,
  RECIPIENT_CHECK_RETENTION_SEC,
} from '@repo/shared';
import { Queue, QueueEvents } from 'bullmq';
import { Logger as PinoLogger } from 'nestjs-pino';
import { withoutPaymentCrons } from '../../__tests__/payment-cron-isolation';
import { SimulatorScript } from '../../adapters/simulator/simulator-script';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import { buildAdapterRegistry } from '../../fulfillment/adapter-registry';
import { FULFILL_ADAPTERS } from '../../fulfillment/fulfill-tokens';
import { workerBullOptions } from '../../infra/queue/queue.module';
import { CaptureStream } from '../../logging/__tests__/capture-stream';
import {
  cleanUpPriceSync,
  cleanupSince,
} from '../../pricing-sync/__tests__/price-sync-e2e-cleanup';
import { WorkerModule } from '../../worker.module';
import { RecipientProducts, recipientCheckJobId, username } from './recipient-e2e.fixtures';
import { stubAdapter } from './recipient-test-doubles';

// The whole WorkerModule (as main.ts boots it, payment crons replaced): RecipientsModule is
// registered and answers on the real queue, and the worker's real log output (logDestination)
// holds no username, display name, providerRef or job id.

const env = buildE2eEnv();
const capture = new CaptureStream();
const bootedSince = cleanupSince();
const asked: string[] = [];
const jobIds: string[] = [];
let moduleRef: TestingModule;
let db: PrismaClient;
let queue: Queue;
let events: QueueEvents;
const products = new RecipientProducts(() => db);

beforeAll(async () => {
  db = createPrismaClient(env.DATABASE_URL);
  const { connection } = workerBullOptions(env);
  queue = new Queue(QUEUES.VALIDATE_RECIPIENT, {
    connection,
    defaultJobOptions: QUEUE_JOB_DEFAULTS[QUEUES.VALIDATE_RECIPIENT],
  });
  events = new QueueEvents(QUEUES.VALIDATE_RECIPIENT, { connection });
  await events.waitUntilReady();
  const registry = new Map(buildAdapterRegistry(env, new SimulatorScript()));
  const thrower = stubAdapter('STUB_THROW', {
    validate: (_product, input) => Promise.reject(new Error(`no user ${input['username'] ?? ''}`)),
  });
  registry.set(thrower.code, thrower);
  moduleRef = await withoutPaymentCrons(
    Test.createTestingModule({
      imports: [WorkerModule.register({ ...env, LOG_LEVEL: 'info' }, { logDestination: capture })],
    }),
  )
    .overrideProvider(FULFILL_ADAPTERS)
    .useValue(registry)
    .compile();
  moduleRef.useLogger(moduleRef.get(PinoLogger));
  await moduleRef.init();
});

afterAll(async () => {
  await moduleRef.close();
  for (const id of jobIds) await queue.remove(id);
  await events.close();
  await queue.close();
  await products.removeAll();
  await db.$disconnect();
  await cleanUpPriceSync(env, bootedSince);
});

async function ask(productId: string, name: string): Promise<unknown> {
  asked.push(name);
  const request = { productId, input: { username: name } };
  const jobId = recipientCheckJobId(request, new Date());
  jobIds.push(jobId);
  const retention = { age: RECIPIENT_CHECK_RETENTION_SEC, count: 1_000 };
  const job = await queue.add(RECIPIENT_CHECK_JOB_NAME, request, {
    jobId,
    removeOnComplete: retention,
    removeOnFail: retention,
  });
  return job.waitUntilFinished(events, 15_000);
}

describe('WorkerModule: validate-recipient is registered', () => {
  it('answers found / not found / provider error, and logs no personal data', async () => {
    const productId = await products.create();
    const failing = await products.create({ adapter: 'STUB_THROW' });
    const found = username('wm_');
    await expect(ask(productId, `@${found.toUpperCase()}`)).resolves.toEqual({
      status: 'FOUND',
      providerRef: `sim_${found}`,
      displayName: found,
    });
    await expect(ask(productId, username('notfound_'))).resolves.toEqual({ status: 'NOT_FOUND' });
    await expect(ask(failing, username('err'))).resolves.toEqual({ status: 'UNAVAILABLE' });

    const lines = capture
      .records()
      .map((record) => String(record['msg']))
      .filter((msg) => msg.startsWith('validate-recipient'));
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('FOUND (ANSWERED) adapter=FRAGMENT');
    expect(lines.join('\n')).toContain('NOT_FOUND (ANSWERED) adapter=FRAGMENT');
    expect(lines.join('\n')).toContain('UNAVAILABLE (ERROR Error) adapter=STUB_THROW');

    const out = capture.text().toLowerCase();
    expect(out).not.toMatch(/sim_|vr-[0-9a-f]{8}|notfound_|no user/);
    for (const name of asked) expect(out).not.toContain(name.toLowerCase().replace(/^@/, ''));
  });
});
