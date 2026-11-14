import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUE_JOB_DEFAULTS, QUEUES, ownerAlertPriority, tgOutboxJobId } from '@repo/shared';
import { Queue, Worker } from 'bullmq';
import { ClockModule } from '../../../common/clock/clock.module';
import { AppConfigModule } from '../../../config/config.module';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import { NotificationsModule } from '../notifications.module';
import { TgOutboxConsumer } from '../tg-outbox.consumer';
import { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';
import { TG_OUTBOX_SENDER } from '../tg-outbox.sender';
import { TG_OUTBOX_CONCURRENCY, TG_OUTBOX_LIMITER } from '../tg-outbox.worker';
import { FakeSender, waitFor } from './tg-outbox.e2e-helpers';

// Audit M-1 (b): a critical owner alert is sent before a flood of ordinary ones that were queued
// earlier, and the 1 msg/s per-chat gate still holds. Real Redis (DB 15) and BullMQ, the real
// tg-outbox consumer; only the Telegram transport is fake. The app boots with the bot off (no
// workers of its own); this file runs its own worker on a private queue name (concurrency 1 for
// the queued-order case, the production concurrency and limiter for the live flood), obliterated
// at the end. Synthetic chat ids, unique per run.
describe('tg-outbox priority (real Redis + BullMQ, fake transport)', () => {
  const env = buildE2eEnv();
  const queueName = `tg-outbox-prio-e2e-${randomUUID()}`;
  const queue = new Queue(queueName, {
    connection: { url: env.REDIS_URL },
    defaultJobOptions: QUEUE_JOB_DEFAULTS[QUEUES.TG_OUTBOX],
  });
  const enqueuer = new TgOutboxEnqueuer(queue);
  const sender = new FakeSender();
  let moduleRef: TestingModule;
  let worker: Worker | undefined;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(env),
        ClockModule,
        PrismaModule,
        RedisModule,
        QueueModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(TG_OUTBOX_SENDER)
      .useValue(sender)
      .compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
  });

  afterAll(async () => {
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await moduleRef.close();
  });

  it('50 queued `held` alerts, then `tonWalletCompromised`: the critical one is sent first', async () => {
    const owner = String(Date.now() * 1_000 + 7);
    const id = (kind: string, n: number) => tgOutboxJobId('alert', kind, String(n), owner);
    for (let n = 0; n < 50; n += 1) {
      await enqueuer.enqueue(
        id('held', n),
        { chatId: owner, text: `held ${String(n)}` },
        ownerAlertPriority('held'),
      );
    }
    await enqueuer.enqueue(
      id('tonWalletCompromised', 0),
      { chatId: owner, text: 'compromised' },
      ownerAlertPriority('tonWalletCompromised'),
    );
    expect(await queue.getJobCountByTypes('wait')).toBe(0); // all of them carry a priority
    expect(await queue.getJobCountByTypes('prioritized')).toBe(51);

    const consumer = moduleRef.get(TgOutboxConsumer);
    worker = new Worker(queueName, (job, token) => consumer.handle(job, token), {
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      concurrency: 1,
    });
    await waitFor(() => sender.deliveriesTo(owner).length >= 3, 15_000);
    await worker.close();

    const sent = sender.deliveriesTo(owner);
    expect(sent[0]?.job.text).toBe('compromised');
    // The gated `held` jobs went to delayed and came back in their own (normal) tier: the next
    // deliveries are `held` ones, and the per-chat gate kept them a second apart.
    expect(sent.slice(1, 3).every((s) => s.job.text.startsWith('held '))).toBe(true);
    for (let i = 1; i < 3; i += 1) {
      const gap = (sent[i]?.at ?? 0) - (sent[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(950);
    }
  }, 30_000);

  // Re-review MAJOR: the flood is ALREADY cycling through the chat gate (delayed, back, gated
  // again) when the critical message arrives. Before the fix the gated jobs came back in time
  // order and up to 8 `held` went out first; now at most the one already past the gate may.
  describe('a critical message during a live flood (production concurrency and limiter)', () => {
    let live: Worker | undefined;
    afterAll(async () => {
      await live?.close();
    });

    const runs = [
      ['tonWalletCompromised', 1],
      ['tonWalletCompromised', 2],
      ['tonWalletCompromised', 3],
      ['owner code (ephemeral)', 4],
    ] as const;

    it.each(runs)(
      '%s (run %s): at most one held is sent after it was queued',
      async (_kind, run) => {
        const owner = String(Date.now() * 1_000 + 100 + run);
        const id = (kind: string, n: number) => tgOutboxJobId('alert', kind, String(n), owner);
        const consumer = moduleRef.get(TgOutboxConsumer);
        live ??= new Worker(queueName, (job, token) => consumer.handle(job, token), {
          connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
          concurrency: TG_OUTBOX_CONCURRENCY,
          limiter: TG_OUTBOX_LIMITER,
        });
        for (let n = 0; n < 10; n += 1) {
          await enqueuer.enqueue(
            id('held', n),
            { chatId: owner, text: `held ${String(n)}` },
            ownerAlertPriority('held'),
          );
        }
        await waitFor(() => sender.deliveriesTo(owner).length >= 2, 30_000);
        const queuedAt = Date.now();
        const critical = { chatId: owner, text: 'critical' };
        if (run === 4) await enqueuer.enqueueEphemeral(`owner_otp-${owner}`, critical);
        else await enqueuer.enqueue(id('tonWalletCompromised', run), critical, 'critical');
        await waitFor(
          () => sender.deliveriesTo(owner).some((s) => s.job.text === 'critical'),
          30_000,
        );

        const sent = sender.deliveriesTo(owner);
        const at = sent.findIndex((s) => s.job.text === 'critical');
        const heldBetween = sent.slice(0, at).filter((s) => s.at >= queuedAt).length;
        expect(heldBetween).toBeLessThanOrEqual(1);
        // The gate still holds: consecutive messages to the chat stay about a second apart.
        await waitFor(() => sender.deliveriesTo(owner).length >= 11, 40_000);
        const times = sender.deliveriesTo(owner).map((s) => s.at);
        for (let i = 1; i < times.length; i += 1) {
          expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(950);
        }
      },
      120_000,
    );
  });
});
