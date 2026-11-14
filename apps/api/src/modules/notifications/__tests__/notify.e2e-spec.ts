import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  cardLimitAlertRef,
  cardReservedHighRef,
  notifyJobId,
  ownerAlertOutboxJobId,
  type NotifyJob,
  type TgOutboxJob,
} from '@repo/shared';
import { Queue, UnrecoverableError } from 'bullmq';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { ClockModule } from '../../../common/clock/clock.module';
import { APP_CONFIG, AppConfigModule, type AppConfig } from '../../../config/config.module';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import { NotificationsModule } from '../notifications.module';
import { NotifySourcesRepository } from '../notify-sources.repository';
import { NotifyConsumer, OwnerChatMissingError } from '../notify.consumer';
import { FulfillmentAlertRenderer } from '../fulfillment-alert.renderer';
import { OrderNotifyRenderer } from '../order-notify.renderer';
import { OwnerAlertRenderer } from '../owner-alert.renderer';
import { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';
import {
  createCard,
  createUser,
  creditedPayment,
  insertMessage,
  retireNotifyCards,
} from './notify-e2e.fixtures';

// Real Postgres (*_test) and Redis DB 15. TELEGRAM_BOT_MODE stays off, so no BullMQ Worker is
// opened: the consumer is called directly and its outbox goes to a PRIVATE queue that is read
// back and obliterated at the end. Nothing here can reach api.telegram.org.
const OWNER_CHAT = '7000000001';

describe('notify consumer (real Postgres + Redis, private outbox queue)', () => {
  const env = buildE2eEnv({
    OWNER_ALERT_CHAT_ID: OWNER_CHAT,
    MINI_APP_URL: 'https://app.ggpin.test/tg',
  });
  const outboxName = `tg-outbox-notify-e2e-${randomUUID()}`;
  const outboxQueue = new Queue(outboxName, { connection: { url: env.REDIS_URL } });
  let moduleRef: TestingModule;
  let consumer: NotifyConsumer;
  let prisma: PrismaService;
  let jobSeq = 0;

  const handle = (data: NotifyJob) => {
    jobSeq += 1;
    return consumer.handle({ id: `n-${String(jobSeq)}`, data });
  };
  // An owner alert is one outbox job per recipient (D-53): this reads the primary's.
  const outboxJob = async (data: NotifyJob): Promise<TgOutboxJob | undefined> => {
    const id =
      data.kind === 'OWNER_ALERT' ? ownerAlertOutboxJobId(data, OWNER_CHAT) : notifyJobId(data);
    const job = await outboxQueue.getJob(id);
    return job?.data as TgOutboxJob | undefined;
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
    await retireNotifyCards(prisma.client);
  });

  afterAll(async () => {
    await retireNotifyCards(prisma.client);
    await outboxQueue.obliterate({ force: true });
    await outboxQueue.close();
    await moduleRef.close();
  });

  it.each([
    ['uz', 'TOPUP_CREDITED', '✅ Hisobingiz to‘ldirildi: 50 123 so‘m\nBalans: 150 123 so‘m'],
    ['ru', 'TOPUP_CREDITED', '✅ Ваш счёт пополнен: 50 123 сум\nБаланс: 150 123 сум'],
    [
      'uz',
      'TOPUP_LATE_CREDITED',
      '✅ Kechikkan to‘lovingiz hisobga tushdi: 50 123 so‘m\nBalans: 150 123 so‘m',
    ],
  ] as const)(
    '%s %s: Payment + SUM(ledger) in the user language, to the user chat',
    async (locale, kind, text) => {
      const user = await createUser(prisma.client, { locale });
      const card = await createCard(prisma.client);
      const payment = await creditedPayment(prisma.client, user, card, 5_012_300n, 10_000_000n);
      const data = { kind, refId: payment.id } as const;
      await expect(handle(data)).resolves.toBe('queued');
      const sent = await outboxJob(data);
      // formatMoney may use a narrow no-break space as the group separator.
      expect(sent?.text.replace(/[\u00a0\u202f]/g, ' ')).toBe(text);
      expect(sent?.chatId).toBe(user.telegramId.toString());
      expect(sent?.replyMarkup?.inline_keyboard[0]?.[0]).toMatchObject({
        web_app: { url: 'https://app.ggpin.test/tg/topup' },
      });
    },
  );

  it('a repeated notify job queues ONE outbox message (jobId topup-<paymentId>)', async () => {
    const user = await createUser(prisma.client);
    const card = await createCard(prisma.client);
    const payment = await creditedPayment(prisma.client, user, card, 5_000_700n);
    const data = { kind: 'TOPUP_CREDITED', refId: payment.id } as const;
    await handle(data);
    await handle(data);
    expect(notifyJobId(data)).toBe(`topup-${payment.id}`);
    const jobs = await outboxQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs.filter((j) => j.id === `topup-${payment.id}`)).toHaveLength(1);
  });

  it('nothing is written to a user who blocked the bot', async () => {
    const user = await createUser(prisma.client, { botBlocked: true });
    const card = await createCard(prisma.client);
    const payment = await creditedPayment(prisma.client, user, card, 5_000_800n);
    const data = { kind: 'TOPUP_CREDITED', refId: payment.id } as const;
    await expect(handle(data)).resolves.toBe('skipped-blocked');
    expect(await outboxJob(data)).toBeUndefined();
  });

  it('a payment reversed before the notification is not announced', async () => {
    const user = await createUser(prisma.client);
    const card = await createCard(prisma.client);
    const payment = await creditedPayment(prisma.client, user, card, 5_000_900n);
    await prisma.client.payment.update({
      where: { id: payment.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await expect(handle({ kind: 'TOPUP_CREDITED', refId: payment.id })).resolves.toBe(
      'skipped-reversed',
    );
  });

  it('an unknown payment or a malformed payload fails without retry', async () => {
    await expect(handle({ kind: 'TOPUP_CREDITED', refId: 'nopaymentx1' })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(
      consumer.handle({ id: 'bad', data: { kind: 'TOPUP_CREDITED', refId: 'a:b' } }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('OWNER_ALERT goes in Uzbek to OWNER_ALERT_CHAT_ID; params come from the rows', async () => {
    const card = await createCard(prisma.client);
    const message = await insertMessage(prisma.client, card, 2_000_000n);
    const data = { kind: 'OWNER_ALERT', alert: 'debit', refId: message.id } as const;
    await expect(handle(data)).resolves.toBe('queued');
    const sent = await outboxJob(data);
    expect(sent?.chatId).toBe(OWNER_CHAT);
    expect(sent?.text.replace(/[\u00a0\u202f]/g, ' ')).toBe(
      `➖ Karta ***${card.last4} dan 20 000 so‘m yechildi.`,
    );
  });

  it('a review alert reads the review and its message (rejected: reason, HTML-escaped)', async () => {
    const message = await insertMessage(prisma.client, null, 1n, {
      parseStatus: 'REJECTED',
      rejectReason: 'AMOUNT_FORMAT',
    });
    const review = await prisma.client.paymentReview.create({
      data: { kind: 'REJECTED', bankMessageId: message.id },
    });
    const data = { kind: 'OWNER_ALERT', alert: 'rejected', refId: review.id } as const;
    await handle(data);
    expect((await outboxJob(data))?.text).toBe(
      `🚫 Bank xabari rad etildi (AMOUNT_FORMAT). Ko‘rib chiqish: ${review.id}`,
    );
  });

  it('lateOverLimit names the card and the amount of the payment (refId = Payment.id)', async () => {
    const user = await createUser(prisma.client);
    const card = await createCard(prisma.client);
    const payment = await creditedPayment(prisma.client, user, card, 5_001_000n);
    const data = { kind: 'OWNER_ALERT', alert: 'lateOverLimit', refId: payment.id } as const;
    await handle(data);
    expect((await outboxJob(data))?.text.replace(/[\u00a0\u202f]/g, ' ')).toContain(
      `UZCARD kartasi ***${card.last4}: kech kelgan 50 010 so‘m to‘lov`,
    );
  });

  it('cardReservedHigh: the percent is computed again from the database now', async () => {
    const user = await createUser(prisma.client);
    const card = await createCard(prisma.client, 10_000_000n);
    // 50 000 so'm held of 100 000 so'm remaining = 50 %.
    await prisma.client.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'P2P_CARD',
        cardId: card.id,
        amountTiyin: 5_000_000n + 100n,
        baseAmountTiyin: 5_000_000n,
        status: 'PENDING',
        purpose: 'TOPUP',
        idempotencyKey: `nt-held-${randomUUID()}`,
        requestHash: 'h',
        expiresAt: new Date(Date.now() + 30 * 60_000),
        reservedUntil: new Date(Date.now() + 25 * 3_600_000),
      },
    });
    const refId = cardReservedHighRef(card.id, new Date());
    const data = { kind: 'OWNER_ALERT', alert: 'cardReservedHigh', refId } as const;
    await handle(data);
    expect((await outboxJob(data))?.text).toContain(
      `***${card.last4}: to‘lanmagan band so‘rovlar qolgan limitning 50% ini`,
    );
  });

  it('cardNearLimit / cardFull read the card from the limit refId; percent is RECEIVED money only (D-45)', async () => {
    const user = await createUser(prisma.client);
    const card = await createCard(prisma.client, 10_000_000n);
    await insertMessage(prisma.client, card, 8_000_000n); // 80 000 of 100 000 so'm arrived
    // A held request of 50 000 so'm would make it 130 % if it counted; it does not.
    await prisma.client.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'P2P_CARD',
        cardId: card.id,
        amountTiyin: 5_000_000n + 200n,
        baseAmountTiyin: 5_000_000n,
        status: 'PENDING',
        purpose: 'TOPUP',
        idempotencyKey: `nt-held-${randomUUID()}`,
        requestHash: 'h',
        expiresAt: new Date(Date.now() + 30 * 60_000),
        reservedUntil: new Date(Date.now() + 25 * 3_600_000),
      },
    });
    const limits = { cardId: card.id, receiveLimitTiyin: 10_000_000n, monthlyLimitTiyin: null };
    const near = {
      kind: 'OWNER_ALERT',
      alert: 'cardNearLimit',
      refId: cardLimitAlertRef('cardNearLimit', limits),
    } as const;
    await handle(near);
    expect((await outboxJob(near))?.text).toBe(
      `📈 UZCARD kartasi ***${card.last4}: limit 80% to‘ldi.`,
    );
    const full = {
      kind: 'OWNER_ALERT',
      alert: 'cardFull',
      refId: cardLimitAlertRef('cardFull', limits),
    } as const;
    await handle(full);
    expect((await outboxJob(full))?.text).toContain(
      `UZCARD kartasi ***${card.last4} limiti to‘ldi`,
    );
    // The old plain-card-id refs are not card-limit refs any more.
    await expect(
      handle({ kind: 'OWNER_ALERT', alert: 'cardNearLimit', refId: `${card.id}_80` }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('an alert whose source row is gone fails without retry', async () => {
    await expect(
      handle({ kind: 'OWNER_ALERT', alert: 'cardFull', refId: 'nocardx1' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('without OWNER_ALERT_CHAT_ID the alert job FAILS (retried, kept failed), nothing queued', async () => {
    const config = moduleRef.get<AppConfig>(APP_CONFIG);
    const bare = new NotifyConsumer(
      moduleRef.get(NotifySourcesRepository),
      moduleRef.get(OwnerAlertRenderer),
      moduleRef.get(TgOutboxEnqueuer),
      { ...config, OWNER_ALERT_CHAT_ID: undefined },
      moduleRef.get(OrderNotifyRenderer),
      moduleRef.get(FulfillmentAlertRenderer),
      moduleRef.get<Clock>(CLOCK),
    );
    const data = { kind: 'OWNER_ALERT', alert: 'sessionRevoked', refId: 'x1' } as const;
    const result = bare.handle({ id: 'n-bare', data });
    await expect(result).rejects.toBeInstanceOf(OwnerChatMissingError);
    // A normal error, not UnrecoverableError: BullMQ retries it and keeps it in the failed set.
    await expect(result).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(await outboxJob(data)).toBeUndefined();
  });
});
