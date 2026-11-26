import { randomBytes, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { notifyJobId, ownerAlertOutboxJobId, type NotifyJob, type TgOutboxJob } from '@repo/shared';
import { Queue } from 'bullmq';
import { ClockModule } from '../../../common/clock/clock.module';
import { AppConfigModule } from '../../../config/config.module';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import {
  buildOrdersCatalog,
  insertPaidOrder,
  insertQuote,
  type OrdersCatalog,
} from '../../orders/__tests__/orders-e2e.fixtures';
import { NotificationsModule } from '../notifications.module';
import { NotifyConsumer } from '../notify.consumer';
import { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';
import { createUser } from './notify-e2e.fixtures';

// Phase 5 S6 on real Postgres (*_test) and Redis DB 15: the order reads of the notify renderers
// against the real schema. TELEGRAM_BOT_MODE stays off (no BullMQ Worker, no watchdog timer) and
// the outbox is a PRIVATE queue that is read back and obliterated: nothing reaches Telegram.
const OWNER_CHAT = '7000000002';

describe('notify consumer: order messages and fulfillment alerts (real rows)', () => {
  const env = buildE2eEnv({
    OWNER_ALERT_CHAT_ID: OWNER_CHAT,
    MINI_APP_URL: 'https://app.ggpin.test/tg',
  });
  const outboxName = `tg-outbox-notify-orders-e2e-${randomUUID()}`;
  const outboxQueue = new Queue(outboxName, { connection: { url: env.REDIS_URL } });
  let moduleRef: TestingModule;
  let consumer: NotifyConsumer;
  let prisma: PrismaService;
  let catalog: OrdersCatalog;
  let seq = 0;

  const handle = (data: NotifyJob) => {
    seq += 1;
    return consumer.handle({ id: `no-${String(seq)}`, data });
  };
  const outboxJob = async (data: NotifyJob): Promise<TgOutboxJob | undefined> => {
    const id =
      data.kind === 'OWNER_ALERT' ? ownerAlertOutboxJobId(data, OWNER_CHAT) : notifyJobId(data);
    return (await outboxQueue.getJob(id))?.data as TgOutboxJob | undefined;
  };
  const paidOrder = async (opts: { locale?: 'uz' | 'ru'; botBlocked?: boolean } = {}) => {
    const user = await createUser(prisma.client, opts);
    const quote = await insertQuote(prisma.client, catalog, user.id, {
      recipient: { username: 'e2e_user', displayName: '<b>E2E</b>' },
    });
    const { orderId } = await insertPaidOrder(prisma.client, quote);
    return { user, orderId };
  };

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
    prisma = moduleRef.get(PrismaService);
    catalog = await buildOrdersCatalog(prisma.client, randomBytes(4).toString('hex'));
  });

  afterAll(async () => {
    await outboxQueue.obliterate({ force: true });
    await outboxQueue.close();
    await moduleRef.close();
  });

  it.each(['uz', 'ru'] as const)(
    'ORDER_ACCEPTED (%s): one escaped message with the button',
    async (locale) => {
      const { user, orderId } = await paidOrder({ locale });
      const data: NotifyJob = { kind: 'ORDER_ACCEPTED', refId: orderId };
      await expect(handle(data)).resolves.toBe('queued');
      await expect(handle(data)).resolves.toBe('queued');
      const job = await outboxJob(data);
      const order = await prisma.client.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(job?.chatId).toBe(user.telegramId.toString());
      expect(job?.text).toContain(`#${String(order.number)}`);
      expect(job?.text).toContain(locale === 'ru' ? catalog.nameRu : catalog.nameUz);
      expect(job?.text).toContain('<code>&lt;b&gt;E2E&lt;/b&gt;</code> (@e2e_user)');
      expect(job?.replyMarkup?.inline_keyboard[0]?.[0]).toMatchObject({
        web_app: { url: `https://app.ggpin.test/tg/orders/${orderId}` },
      });
      const ids = (await outboxQueue.getJobs(['waiting', 'delayed', 'prioritized'])).map(
        (j) => j.id,
      );
      expect(ids.filter((id) => id === notifyJobId(data))).toHaveLength(1);
    },
  );

  it('a user who blocked the bot gets nothing', async () => {
    const { orderId } = await paidOrder({ botBlocked: true });
    const data: NotifyJob = { kind: 'ORDER_ACCEPTED', refId: orderId };
    await expect(handle(data)).resolves.toBe('skipped-blocked');
    expect(await outboxJob(data)).toBeUndefined();
  });

  it('ORDER_REFUNDED of a PAID order without a REFUND entry is skipped as stale', async () => {
    const { orderId } = await paidOrder();
    const data: NotifyJob = { kind: 'ORDER_REFUNDED', refId: orderId };
    await expect(handle(data)).resolves.toBe('skipped-stale');
    expect(await outboxJob(data)).toBeUndefined();
  });

  it('needsReview reads the order; transfer and snapshot alerts of unknown rows still go out', async () => {
    const { orderId } = await paidOrder();
    const review: NotifyJob = { kind: 'OWNER_ALERT', alert: 'needsReview', refId: orderId };
    await expect(handle(review)).resolves.toBe('queued');
    expect((await outboxJob(review))?.text).toContain(`Buyurtma: ${orderId}`);
    for (const alert of ['tonWalletBlocked', 'tonLowBalance'] as const) {
      const data: NotifyJob = { kind: 'OWNER_ALERT', alert, refId: 'cmnosuchrow1' };
      await expect(handle(data)).resolves.toBe('queued');
      expect((await outboxJob(data))?.text).toContain('?');
    }
  });
});
