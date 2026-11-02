import { Writable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { HttpError } from 'grammy';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import {
  buildTestEnv,
  TEST_BOT_TOKEN,
  TEST_WEBHOOK_SECRET,
} from '../../../config/__tests__/test-env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { TG_OUTBOX_SENDER } from '../../notifications/tg-outbox.sender';
import { BOT } from '../bot.provider';
import { createFakeTelegram } from './fake-telegram-api';
import { textUpdate } from './updates';

const WEBHOOK_PATH = '/api/v1/telegram/webhook';
const WEBHOOK_URL = `https://hooks.example.test${WEBHOOK_PATH}`;
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

// buildE2eEnv enforces the _test database guard and the Redis DB; reuse its URLs, then turn
// webhook mode on and logs up to info so the error-logging path can be asserted.
function buildWebhookEnv(): ReturnType<typeof buildTestEnv> {
  const base = buildE2eEnv();
  return buildTestEnv({
    DATABASE_URL: base.DATABASE_URL,
    REDIS_URL: base.REDIS_URL,
    LOG_LEVEL: 'info',
    TELEGRAM_BOT_MODE: 'webhook',
    TELEGRAM_WEBHOOK_URL: WEBHOOK_URL,
    TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    MINI_APP_URL: 'https://app.example.test/tg',
  });
}

describe('POST /api/v1/telegram/webhook (real app, fake Bot API)', () => {
  const fake = createFakeTelegram();
  const logLines: string[] = [];
  const createdTelegramIds: bigint[] = [];
  let app: NestFastifyApplication;
  let db: PrismaService['client'];
  let seq = 0;

  const newId = (): number => {
    seq += 1;
    const id = Date.now() * 10 + seq;
    createdTelegramIds.push(BigInt(id));
    return id;
  };
  const post = (body: unknown, secret?: string) =>
    app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: secret === undefined ? {} : { [SECRET_HEADER]: secret },
      payload: body as object,
    });

  beforeAll(async () => {
    const env = buildWebhookEnv();
    const logDestination = new Writable({
      write(chunk: Buffer, _enc, done) {
        logLines.push(chunk.toString());
        done();
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env, { logDestination })],
    })
      .overrideProvider(BOT)
      .useValue(fake.bot)
      // The webhook-mode app runs a real outbox worker on the shared queue: nothing may reach Telegram.
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
  });

  afterAll(async () => {
    const rows = await db.user.findMany({
      where: { telegramId: { in: createdTelegramIds } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    await db.wallet.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('registers the webhook with the secret and allowed updates at boot', () => {
    const [call] = fake.callsOf('setWebhook');
    expect(call?.payload).toEqual({
      url: WEBHOOK_URL,
      secret_token: TEST_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });
    expect(fake.callsOf('setMyCommands')).toHaveLength(3);
  });

  it('wrong or missing secret -> 404 and the update is not processed', async () => {
    const id = newId();
    const before = fake.calls.length;
    const wrong = await post(textUpdate({ id }, '/start'), 'x'.repeat(TEST_WEBHOOK_SECRET.length));
    const short = await post(textUpdate({ id }, '/start'), 'short');
    const missing = await post(textUpdate({ id }, '/start'));
    expect([wrong.statusCode, short.statusCode, missing.statusCode]).toEqual([404, 404, 404]);
    expect(fake.calls.length).toBe(before);
    expect(await db.user.count({ where: { telegramId: BigInt(id) } })).toBe(0);
  });

  it('correct secret -> 200, handler ran, user created in the DB', async () => {
    const id = newId();
    const res = await post(textUpdate({ id, language_code: 'ru' }, '/start'), TEST_WEBHOOK_SECRET);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const user = await db.user.findUnique({ where: { telegramId: BigInt(id) } });
    expect(user?.locale).toBe('ru');
    const sent = fake.callsOf('sendMessage').filter((c) => c.payload['chat_id'] === id);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload['text']).toContain('Выберите язык');
  });

  it('malformed body with a correct secret -> 400, nothing processed', async () => {
    const res = await post({ nope: true }, TEST_WEBHOOK_SECRET);
    expect(res.statusCode).toBe(400);
  });

  it('a handler that throws still gets 200; the error is logged without the update or token', async () => {
    const id = newId();
    fake.failMethod('sendMessage');
    const res = await post(textUpdate({ id }, '/start secret-user-text'), TEST_WEBHOOK_SECRET);
    expect(res.statusCode).toBe(200);
    const logs = logLines.join('');
    expect(logs).toContain('failed');
    expect(logs).not.toContain('secret-user-text');
    expect(logs).not.toContain(TEST_BOT_TOKEN);
  });

  it('a network error that quotes the bot token in its message is logged scrubbed', async () => {
    const id = newId();
    const url = `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`;
    let armed = true;
    fake.bot.api.config.use((prev, method, payload, signal) => {
      if (!armed || method !== 'sendMessage') return prev(method, payload, signal);
      throw new HttpError(
        `Network request for 'sendMessage' failed! request to ${url} failed`,
        new Error(`request to ${url} failed, reason: connect ETIMEDOUT`),
      );
    });
    logLines.length = 0;
    const res = await post(textUpdate({ id }, '/start'), TEST_WEBHOOK_SECRET);
    armed = false;
    expect(res.statusCode).toBe(200);
    const logs = logLines.join('');
    expect(logs).toContain('HttpError');
    expect(logs).not.toContain(TEST_BOT_TOKEN);
    expect(logs).not.toContain('a'.repeat(32));
  });
});
