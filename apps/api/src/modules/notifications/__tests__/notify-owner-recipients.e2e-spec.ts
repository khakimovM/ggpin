import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ownerAlertOutboxJobId, type NotifyJob, type TgOutboxJob } from '@repo/shared';
import { Queue } from 'bullmq';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { ClockModule } from '../../../common/clock/clock.module';
import { APP_CONFIG, AppConfigModule, type AppConfig } from '../../../config/config.module';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import { NotificationsModule } from '../notifications.module';
import { NotifySourcesRepository } from '../notify-sources.repository';
import { NotifyConsumer } from '../notify.consumer';
import { FulfillmentAlertRenderer } from '../fulfillment-alert.renderer';
import { OrderNotifyRenderer } from '../order-notify.renderer';
import { OwnerAlertRenderer } from '../owner-alert.renderer';
import { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';

// Owner alerts reach both partners (D-53), against real Redis DB 15 and a PRIVATE outbox queue
// (read back and obliterated at the end; nothing can reach api.telegram.org). The listed ids are
// synthetic, with a repeat on purpose: the env parse drops it.
const PRIMARY = '7000000011';
const PARTNER = '7000000012';

describe('notify consumer: owner alert to two partners (real Redis, private outbox queue)', () => {
  const env = buildE2eEnv({ OWNER_ALERT_CHAT_ID: `${PRIMARY}, ${PARTNER},${PRIMARY}` });
  const outboxQueue = new Queue(`tg-outbox-notify-partners-e2e-${randomUUID()}`, {
    connection: { url: env.REDIS_URL },
  });
  let moduleRef: TestingModule;
  let consumer: NotifyConsumer;
  let seq = 0;

  // sessionRevoked needs no source row, so each test gets its own alert by its own refId.
  const alertOf = (): Extract<NotifyJob, { kind: 'OWNER_ALERT' }> => {
    seq += 1;
    return { kind: 'OWNER_ALERT', alert: 'sessionRevoked', refId: `partners${String(seq)}x` };
  };
  const handle = (data: NotifyJob) => consumer.handle({ id: `p-${String(seq)}`, data });
  const jobOf = async (
    data: Extract<NotifyJob, { kind: 'OWNER_ALERT' }>,
    chatId: string,
  ): Promise<TgOutboxJob | undefined> =>
    (await outboxQueue.getJob(ownerAlertOutboxJobId(data, chatId)))?.data as
      TgOutboxJob | undefined;
  const queuedFor = async (data: Extract<NotifyJob, { kind: 'OWNER_ALERT' }>) =>
    (await outboxQueue.getJobs(['waiting', 'delayed', 'prioritized'])).filter((j) =>
      (j.id ?? '').startsWith(`alert-${data.alert}-${data.refId}-`),
    );

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
      .overrideProvider(TgOutboxEnqueuer)
      .useValue(new TgOutboxEnqueuer(outboxQueue))
      .compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    consumer = moduleRef.get(NotifyConsumer);
  });

  afterAll(async () => {
    await outboxQueue.obliterate({ force: true });
    await outboxQueue.close();
    await moduleRef.close();
  });

  it('the env keeps the two distinct ids, primary first', () => {
    expect(moduleRef.get<AppConfig>(APP_CONFIG).OWNER_ALERT_CHAT_ID).toBe(`${PRIMARY},${PARTNER}`);
  });

  it('each partner gets the same alert as its own outbox job', async () => {
    const data = alertOf();
    await expect(handle(data)).resolves.toBe('queued');
    const first = await jobOf(data, PRIMARY);
    const second = await jobOf(data, PARTNER);
    expect(first?.chatId).toBe(PRIMARY);
    expect(second?.chatId).toBe(PARTNER);
    expect(first?.text).toBe(second?.text);
    expect(first?.text).toContain('Bank xabarlari sessiyasi bekor qilingan');
    expect(await queuedFor(data)).toHaveLength(2);
  });

  it('a replayed notify job queues nothing more: one message per partner', async () => {
    const data = alertOf();
    await handle(data);
    await handle(data);
    expect(await queuedFor(data)).toHaveLength(2);
  });

  // The retry case: the notify job failed after the first partner was queued. The retry must
  // add the missing partner and must not queue the first one again.
  it('a retry after a partial failure adds only the missing partner', async () => {
    const data = alertOf();
    let failPartner = true;
    const flaky = {
      enqueue: async (id: string, job: TgOutboxJob) => {
        if (failPartner && job.chatId === PARTNER) throw new Error('redis hiccup');
        await new TgOutboxEnqueuer(outboxQueue).enqueue(id, job);
      },
    } as unknown as TgOutboxEnqueuer;
    const retrying = new NotifyConsumer(
      moduleRef.get(NotifySourcesRepository),
      moduleRef.get(OwnerAlertRenderer),
      flaky,
      moduleRef.get<AppConfig>(APP_CONFIG),
      moduleRef.get(OrderNotifyRenderer),
      moduleRef.get(FulfillmentAlertRenderer),
      moduleRef.get<Clock>(CLOCK),
    );
    await expect(retrying.handle({ id: 'p-flaky', data })).rejects.toThrow('redis hiccup');
    expect(await jobOf(data, PRIMARY)).toBeDefined();
    expect(await jobOf(data, PARTNER)).toBeUndefined();

    failPartner = false;
    await expect(retrying.handle({ id: 'p-flaky', data })).resolves.toBe('queued');
    expect(await queuedFor(data)).toHaveLength(2);
  });
});
