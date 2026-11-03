import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUE_JOB_DEFAULTS, QUEUES, tgOutboxJobId, type TgOutboxJob } from '@repo/shared';
import { Queue, type Job } from 'bullmq';
import { HttpError } from 'grammy';
import { ClockModule } from '../../../common/clock/clock.module';
import { AppConfigModule } from '../../../config/config.module';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import { UsersService } from '../../users/users.service';
import { NotificationsModule } from '../notifications.module';
import { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';
import { TG_OUTBOX_SENDER } from '../tg-outbox.sender';
import { FakeSender, telegramError, wait, waitFor } from './tg-outbox.e2e-helpers';
import {
  TG_OUTBOX_CONCURRENCY,
  TG_OUTBOX_LIMITER,
  TG_OUTBOX_QUEUE_NAME,
  TgOutboxWorker,
} from '../tg-outbox.worker';

// Real Redis (logical DB 15), real Postgres (*_test), real BullMQ worker; only the Telegram
// transport is fake, so nothing here can reach api.telegram.org.
//
// Isolation from parallel suites: the worker listens on a private queue name
// (`tg-outbox-e2e-<uuid>`, via TG_OUTBOX_QUEUE_NAME), never on the shared `tg-outbox` queue, so
// this file neither consumes other suites' jobs nor has its own consumed by someone else's
// processor. No FLUSHDB; the private queue is obliterated at the end. Chat ids and message ids
// are built at runtime and unique per run.
describe('tg-outbox consumer (real Redis + Postgres, fake transport)', () => {
  const env = { ...buildE2eEnv(), TELEGRAM_BOT_MODE: 'polling' as const };
  const queueName = `tg-outbox-e2e-${randomUUID()}`;
  const createdTelegramIds: bigint[] = [];
  let seq = 0;

  const newTelegramId = (): bigint => {
    seq += 1;
    const id = BigInt(Date.now()) * 1_000n + BigInt(seq);
    createdTelegramIds.push(id);
    return id;
  };

  async function boot(sender: FakeSender): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({
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
      .overrideProvider(TG_OUTBOX_QUEUE_NAME)
      .useValue(queueName)
      .compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    return moduleRef;
  }

  // Private queue with a short backoff so a retried job does not make the suite wait 2 s.
  const queue = new Queue(queueName, {
    connection: { url: env.REDIS_URL },
    defaultJobOptions: {
      ...QUEUE_JOB_DEFAULTS[QUEUES.TG_OUTBOX],
      backoff: { type: 'exponential', delay: 50 },
    },
  });
  const enqueuer = new TgOutboxEnqueuer(queue);

  const send = (chatId: string, text = 'hello'): Promise<string> => {
    const id = tgOutboxJobId('e2e', randomUUID().replaceAll('-', '_'));
    return enqueuer.enqueue(id, { chatId, text }).then(() => id);
  };
  const jobOf = async (id: string): Promise<Job> => {
    const job = await queue.getJob(id);
    if (job === undefined) throw new Error('job missing');
    return job;
  };

  describe('delivery', () => {
    const sender = new FakeSender();
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await boot(sender);
    });
    afterAll(async () => {
      await moduleRef.close();
    });
    beforeEach(() => {
      sender.script = () => Promise.resolve();
    });

    it('delivers an enqueued job to the transport exactly once with its payload', async () => {
      const chatId = newTelegramId().toString();
      const payload: TgOutboxJob = {
        chatId,
        text: '<b>Order delivered</b>',
        disableNotification: true,
        replyMarkup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.test' }]] },
      };
      const id = tgOutboxJobId('e2e', randomUUID().replaceAll('-', '_'));
      await enqueuer.enqueue(id, payload);
      await waitFor(async () => (await jobOf(id)).isCompleted());
      expect(sender.deliveriesTo(chatId).map((s) => s.job)).toEqual([payload]);
    });

    it('sends once when the same messageId is enqueued twice', async () => {
      const chatId = newTelegramId().toString();
      const id = tgOutboxJobId('e2e', randomUUID().replaceAll('-', '_'));
      await enqueuer.enqueue(id, { chatId, text: 'once' });
      await enqueuer.enqueue(id, { chatId, text: 'once' });
      await waitFor(() => sender.deliveriesTo(chatId).length >= 1);
      await wait(400);
      expect(sender.deliveriesTo(chatId)).toHaveLength(1);
    });

    it('delays (does not drop) a second message to the same chat by about 1 s', async () => {
      const chatId = newTelegramId().toString();
      await Promise.all([send(chatId, 'first'), send(chatId, 'second')]);
      await waitFor(() => sender.deliveriesTo(chatId).length === 2, 15_000);
      const [a, b] = sender.deliveriesTo(chatId);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(Math.abs((b?.at ?? 0) - (a?.at ?? 0))).toBeGreaterThanOrEqual(850);
      expect(
        sender
          .deliveriesTo(chatId)
          .map((s) => s.job.text)
          .sort(),
      ).toEqual(['first', 'second']);
    });

    it('does not delay messages to different chats', async () => {
      const a = newTelegramId().toString();
      const b = newTelegramId().toString();
      await Promise.all([send(a), send(b)]);
      await waitFor(() => sender.deliveriesTo(a).length + sender.deliveriesTo(b).length === 2);
      const times = [...sender.deliveriesTo(a), ...sender.deliveriesTo(b)].map((s) => s.at);
      expect(Math.abs((times[0] ?? 0) - (times[1] ?? 0))).toBeLessThan(800);
    });

    it('delays a 429 by retry_after and delivers it later without burning an attempt', async () => {
      const chatId = newTelegramId().toString();
      sender.script = (job, call) =>
        job.chatId === chatId && call === 1
          ? Promise.reject(telegramError(429, 'Too Many Requests: retry after 1', 1))
          : Promise.resolve();
      const started = Date.now();
      const id = await send(chatId);
      await waitFor(async () => (await jobOf(id)).isCompleted(), 15_000);
      const job = await jobOf(id);
      expect(sender.calls.get(chatId)).toBe(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      // One attempt for the run that finally succeeded; the 429 run did not count.
      expect(job.attemptsMade).toBe(1);
    });

    it('retries a transient network error with backoff and then succeeds', async () => {
      const chatId = newTelegramId().toString();
      sender.script = (job, call) =>
        job.chatId === chatId && call === 1
          ? Promise.reject(new HttpError('Network request failed', new Error('ECONNRESET')))
          : Promise.resolve();
      const id = await send(chatId);
      await waitFor(async () => (await jobOf(id)).isCompleted(), 15_000);
      expect(sender.calls.get(chatId)).toBe(2);
      expect((await jobOf(id)).attemptsMade).toBe(2);
    });

    it('fails a 403 immediately, without retries, and flags the user in the database', async () => {
      const telegramId = newTelegramId();
      const chatId = telegramId.toString();
      await moduleRef.get(UsersService).ensureTelegramUser({ telegramId }, { now: new Date() });
      sender.script = (job) =>
        job.chatId === chatId
          ? Promise.reject(telegramError(403, 'Forbidden: bot was blocked by the user'))
          : Promise.resolve();
      const id = await send(chatId);
      await waitFor(async () => (await jobOf(id)).isFailed(), 15_000);
      await wait(400); // a retry would show up as a second call within the 50 ms backoff
      expect(sender.calls.get(chatId)).toBe(1);
      expect((await jobOf(id)).attemptsMade).toBe(1);
      const user = await moduleRef
        .get(PrismaService)
        .client.user.findUnique({ where: { telegramId } });
      expect(user?.botBlockedAt).toBeInstanceOf(Date);
    });

    it('opens the worker with its own connection: offline queue on, no request retry limit', async () => {
      const worker = moduleRef.get(TgOutboxWorker).worker;
      if (worker === undefined) throw new Error('worker not started');
      const client = await worker.client;
      expect(client.options).toMatchObject({
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
      });
      expect(worker.opts.concurrency).toBe(TG_OUTBOX_CONCURRENCY);
      expect(worker.opts.limiter).toEqual(TG_OUTBOX_LIMITER);
      expect(worker.name).toBe(queueName);
    });
  });

  it('drains an in-flight job before Prisma disconnects', async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sender = new FakeSender();
    sender.script = async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await wait(150);
      events.push('send.finished');
    };
    const moduleRef = await boot(sender);
    const prisma = moduleRef.get(PrismaService).client;
    const disconnect = prisma.$disconnect.bind(prisma);
    jest.spyOn(prisma, '$disconnect').mockImplementation(() => {
      events.push('prisma.$disconnect');
      return disconnect();
    });

    const id = await send(newTelegramId().toString());
    await running;
    const closing = moduleRef.close();
    release();
    await closing;

    expect(events).toEqual(['send.finished', 'prisma.$disconnect']);
    expect(await (await jobOf(id)).isCompleted()).toBe(true);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    const app = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(env), PrismaModule],
    }).compile();
    const client = app.get(PrismaService).client;
    const rows = await client.user.findMany({
      where: { telegramId: { in: createdTelegramIds } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    await client.wallet.deleteMany({ where: { userId: { in: ids } } });
    await client.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });
});
