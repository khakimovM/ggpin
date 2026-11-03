import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ACCESS_COOKIE_NAME,
  QUEUES,
  REFRESH_COOKIE_NAME,
  sessionEndCallbackData,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { buildTestEnv, TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { cookieValue, ME, REFRESH, START, VERIFY } from '../../auth/__tests__/auth-otp.helpers';
import { newLoginJobId } from '../../auth/new-login-notice.service';
import { TG_OUTBOX_SENDER } from '../../notifications/tg-outbox.sender';
import { BOT } from '../bot.provider';
import { denyCallbackData } from '../login-keyboards';
import { createFakeTelegram } from './fake-telegram-api';
import { callbackUpdate, myChatMemberUpdate, textUpdate } from './updates';

const WEBHOOK_PATH = '/api/v1/telegram/webhook';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

interface Login {
  readonly id: number;
  readonly nonce: string;
  readonly familyId: string;
  readonly cookie: string;
  readonly refreshCookie: string;
}

// Real app, Postgres, Redis and queue; only the Bot API transport and the outbox sender are fake.
describe('sessions and chat-member updates through the bot webhook', () => {
  const fake = createFakeTelegram();
  const telegramIds: bigint[] = [];
  const nonces: string[] = [];
  let app: NestFastifyApplication;
  let db: PrismaService['client'];
  let outbox: Queue;
  let webUrl: string;
  let seq = 0;

  const newId = (): number => {
    seq += 1;
    const id = Date.now() * 10 + seq;
    telegramIds.push(BigInt(id));
    return id;
  };
  const ip = (): string => `10.78.${String(Math.floor(seq / 250))}.${String((seq % 250) + 1)}`;
  const webhook = (update: object) =>
    app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { [SECRET_HEADER]: TEST_WEBHOOK_SECRET },
      payload: update,
    });
  const post = (url: string, payload: object, cookie?: string) => {
    seq += 1;
    return app.inject({
      method: 'POST',
      url,
      payload,
      remoteAddress: ip(),
      headers: {
        'x-csrf-token': 'e2e',
        origin: webUrl,
        ...(cookie === undefined ? {} : { cookie }),
      },
    });
  };
  const me = (cookie: string) =>
    app.inject({ method: 'GET', url: ME, headers: { cookie }, remoteAddress: ip() });

  // The whole journey: web start, the bot hands out the code, the web verifies it.
  const login = async (id: number): Promise<Login> => {
    await webhook(textUpdate({ id }, '/start'));
    await db.user.update({ where: { telegramId: BigInt(id) }, data: { phone: '+998901110000' } });
    const started = await post(START, {});
    const nonce = started.json<{ data: { nonce: string } }>().data.nonce;
    nonces.push(nonce);
    await webhook(textUpdate({ id }, `/start login_${nonce}`));
    const sent = fake
      .callsOf('sendMessage')
      .filter((c) => c.payload['chat_id'] === id)
      .map((c) => /<code>(\d{6})<\/code>/.exec(String(c.payload['text']))?.[1]);
    const code = sent.find((c) => c !== undefined) ?? '';
    const verified = await post(VERIFY, { nonce, code });
    expect(verified.statusCode).toBe(200);
    const access = cookieValue(verified, ACCESS_COOKIE_NAME);
    const refresh = cookieValue(verified, REFRESH_COOKIE_NAME);
    const row = await db.user.findUniqueOrThrow({
      where: { telegramId: BigInt(id) },
      select: { webSessions: { select: { familyId: true } } },
    });
    const familyId = row.webSessions[0]?.familyId ?? '';
    return {
      id,
      nonce,
      familyId,
      cookie: `${ACCESS_COOKIE_NAME}=${access}`,
      refreshCookie: `${ACCESS_COOKIE_NAME}=${access}; ${REFRESH_COOKIE_NAME}=${refresh}`,
    };
  };

  beforeAll(async () => {
    const base = buildE2eEnv();
    webUrl = base.WEB_URL;
    const env = buildTestEnv({
      DATABASE_URL: base.DATABASE_URL,
      REDIS_URL: base.REDIS_URL,
      TELEGRAM_BOT_MODE: 'webhook',
      TELEGRAM_WEBHOOK_URL: `https://hooks.example.test${WEBHOOK_PATH}`,
      TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
      .overrideProvider(BOT)
      .useValue(fake.bot)
      .overrideProvider(TG_OUTBOX_SENDER)
      .useValue({ send: () => Promise.resolve() })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(PrismaService).client;
    outbox = app.get<Queue>(getQueueToken(QUEUES.TG_OUTBOX));
  });

  afterAll(async () => {
    const rows = await db.user.findMany({
      where: { telegramId: { in: telegramIds } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    const sessions = await db.webSession.findMany({
      where: { userId: { in: ids } },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    for (const { familyId } of sessions) await outbox.remove(newLoginJobId(familyId));
    await db.loginRequest.deleteMany({
      where: { OR: [{ nonce: { in: nonces } }, { telegramId: { in: telegramIds } }] },
    });
    await db.webSession.deleteMany({ where: { userId: { in: ids } } });
    await db.wallet.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('the new-login notice carries the end button, and pressing it kills the session', async () => {
    const s = await login(newId());
    const job = await outbox.getJob(newLoginJobId(s.familyId));
    const data = job?.data as { replyMarkup?: { inline_keyboard: { callback_data: string }[][] } };
    expect(data.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data).toBe(
      sessionEndCallbackData(s.familyId),
    );
    expect((await me(s.cookie)).statusCode).toBe(200);

    const res = await webhook(callbackUpdate({ id: s.id }, sessionEndCallbackData(s.familyId)));
    expect(res.statusCode).toBe(200);
    expect(fake.callsOf('editMessageText').some((c) => c.payload['chat_id'] === s.id)).toBe(true);
    expect((await me(s.cookie)).statusCode).toBe(401);
    expect((await post(REFRESH, {}, s.refreshCookie)).statusCode).toBe(401);
  });

  it('the same button pressed by another Telegram user changes nothing', async () => {
    const s = await login(newId());
    const intruder = newId();
    await webhook(callbackUpdate({ id: intruder }, sessionEndCallbackData(s.familyId)));
    expect(
      fake.callsOf('editMessageReplyMarkup').some((c) => c.payload['chat_id'] === intruder),
    ).toBe(true);
    expect((await me(s.cookie)).statusCode).toBe(200);
    expect((await post(REFRESH, {}, s.refreshCookie)).statusCode).toBe(200);
  });

  it('"not me" pressed after the code was used ends the session', async () => {
    const s = await login(newId());
    expect((await me(s.cookie)).statusCode).toBe(200);
    await webhook(callbackUpdate({ id: s.id }, denyCallbackData(s.nonce)));
    expect((await me(s.cookie)).statusCode).toBe(401);
    const edits = fake.callsOf('editMessageText').filter((c) => c.payload['chat_id'] === s.id);
    expect(edits.length).toBeGreaterThan(0);
  });

  it('kicked sets botBlockedAt and /start clears it', async () => {
    const id = newId();
    await webhook(textUpdate({ id }, '/start'));
    await webhook(myChatMemberUpdate({ id }, 'kicked'));
    const blocked = await db.user.findUnique({ where: { telegramId: BigInt(id) } });
    expect(blocked?.botBlockedAt).not.toBeNull();
    await webhook(textUpdate({ id }, '/start'));
    const back = await db.user.findUnique({ where: { telegramId: BigInt(id) } });
    expect(back?.botBlockedAt).toBeNull();
  });
});
