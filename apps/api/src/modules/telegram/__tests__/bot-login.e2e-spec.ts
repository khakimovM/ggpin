import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ACCESS_COOKIE_NAME } from '@repo/shared';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { buildTestEnv, TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { cookieValue, ME, START, statusUrl, VERIFY } from '../../auth/__tests__/auth-otp.helpers';
import { TG_OUTBOX_SENDER } from '../../notifications/tg-outbox.sender';
import { BOT } from '../bot.provider';
import { denyCallbackData } from '../login-keyboards';
import { createFakeTelegram } from './fake-telegram-api';
import { callbackUpdate, contactUpdate, textUpdate } from './updates';

const WEBHOOK_PATH = '/api/v1/telegram/webhook';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

// Real app, real Postgres/Redis, real OtpLoginService; only the Bot API transport is fake.
describe('web login through the bot (real app, fake Bot API)', () => {
  const fake = createFakeTelegram();
  const telegramIds: bigint[] = [];
  const nonces: string[] = [];
  let app: NestFastifyApplication;
  let db: PrismaService['client'];
  let webUrl: string;
  let seq = 0;

  const newId = (): number => {
    seq += 1;
    const id = Date.now() * 10 + seq;
    telegramIds.push(BigInt(id));
    return id;
  };
  const ip = (): string => `10.77.${String(Math.floor(seq / 250))}.${String((seq % 250) + 1)}`;
  const webhook = (update: object) =>
    app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { [SECRET_HEADER]: TEST_WEBHOOK_SECRET },
      payload: update,
    });
  const webStart = async (): Promise<string> => {
    seq += 1;
    const res = await app.inject({
      method: 'POST',
      url: START,
      payload: {},
      remoteAddress: ip(),
      headers: { 'x-csrf-token': 'e2e', origin: webUrl },
    });
    const nonce = res.json<{ data: { nonce: string } }>().data.nonce;
    nonces.push(nonce);
    return nonce;
  };
  const status = async (nonce: string): Promise<string> => {
    seq += 1;
    const res = await app.inject({ method: 'GET', url: statusUrl(nonce), remoteAddress: ip() });
    return res.json<{ data: { status: string } }>().data.status;
  };
  const messagesTo = (chatId: number) =>
    fake.callsOf('sendMessage').filter((c) => c.payload['chat_id'] === chatId);
  const codeSentTo = (chatId: number): string[] =>
    messagesTo(chatId).flatMap((c) => {
      const m = /<code>(\d{6})<\/code>/.exec(String(c.payload['text']));
      return m?.[1] === undefined ? [] : [m[1]];
    });
  const verify = (nonce: string, code: string) => {
    seq += 1;
    return app.inject({
      method: 'POST',
      url: VERIFY,
      payload: { nonce, code },
      remoteAddress: ip(),
      headers: { 'x-csrf-token': 'e2e', origin: webUrl },
    });
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
      where: { telegramId: { in: telegramIds } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    await db.loginRequest.deleteMany({
      where: { OR: [{ nonce: { in: nonces } }, { telegramId: { in: telegramIds } }] },
    });
    await db.webSession.deleteMany({ where: { userId: { in: ids } } });
    await db.wallet.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('known phone: /start login_ -> code from the bot -> verify -> session -> /me', async () => {
    const id = newId();
    await webhook(textUpdate({ id }, '/start')); // creates the account
    await db.user.update({ where: { telegramId: BigInt(id) }, data: { phone: '+998901112233' } });
    const nonce = await webStart();
    expect(await status(nonce)).toBe('PENDING');

    const res = await webhook(textUpdate({ id }, `/start login_${nonce}`));
    expect(res.statusCode).toBe(200);
    const [code] = codeSentTo(id);
    expect(code).toMatch(/^\d{6}$/);
    expect(messagesTo(id).at(-1)?.payload['protect_content']).toBe(true);
    expect(await status(nonce)).toBe('CODE_SENT');

    const verified = await verify(nonce, code ?? '');
    expect(verified.statusCode).toBe(200);
    const access = cookieValue(verified, ACCESS_COOKIE_NAME);
    const me = await app.inject({
      method: 'GET',
      url: ME,
      headers: { cookie: `${ACCESS_COOKIE_NAME}=${access}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('no phone: the bot asks for the contact, then issues the code; verify works', async () => {
    const id = newId();
    const nonce = await webStart();
    await webhook(textUpdate({ id }, `/start login_${nonce}`));
    expect(codeSentTo(id)).toHaveLength(0);
    expect(JSON.stringify(messagesTo(id)[0]?.payload['reply_markup'])).toContain('request_contact');
    expect(await status(nonce)).toBe('PENDING');

    await webhook(contactUpdate({ id }, { phone_number: '998907770011', user_id: id }));
    const user = await db.user.findUnique({ where: { telegramId: BigInt(id) } });
    expect(user?.phone).toBe('+998907770011');
    expect(messagesTo(id)[1]?.payload['reply_markup']).toEqual({ remove_keyboard: true });
    const [code] = codeSentTo(id);
    expect(code).toMatch(/^\d{6}$/);
    expect(await status(nonce)).toBe('CODE_SENT');
    expect((await verify(nonce, code ?? '')).statusCode).toBe(200);
  });

  it("someone else's contact is not stored and no code is issued", async () => {
    const id = newId();
    const nonce = await webStart();
    await webhook(textUpdate({ id }, `/start login_${nonce}`));
    await webhook(contactUpdate({ id }, { phone_number: '998905550000', user_id: id + 1 }));
    const user = await db.user.findUnique({ where: { telegramId: BigInt(id) } });
    expect(user?.phone).toBeNull();
    expect(codeSentTo(id)).toHaveLength(0);
    expect(await status(nonce)).toBe('PENDING');
  });

  it('the deny button makes the request DENIED and the code useless', async () => {
    const id = newId();
    await webhook(textUpdate({ id }, '/start'));
    await db.user.update({ where: { telegramId: BigInt(id) }, data: { phone: '+998901119999' } });
    const nonce = await webStart();
    await webhook(textUpdate({ id }, `/start login_${nonce}`));
    const [code] = codeSentTo(id);

    await webhook(callbackUpdate({ id }, denyCallbackData(nonce)));
    expect(await status(nonce)).toBe('DENIED');
    expect(fake.callsOf('editMessageText').some((c) => c.payload['chat_id'] === id)).toBe(true);
    expect((await verify(nonce, code ?? '')).statusCode).toBe(422);
  });

  it('a duplicate /start login_ delivery sends no second code', async () => {
    const id = newId();
    await webhook(textUpdate({ id }, '/start'));
    await db.user.update({ where: { telegramId: BigInt(id) }, data: { phone: '+998901118888' } });
    const nonce = await webStart();
    await webhook(textUpdate({ id }, `/start login_${nonce}`));
    await webhook(textUpdate({ id }, `/start login_${nonce}`));
    expect(codeSentTo(id)).toHaveLength(1);
    expect(String(messagesTo(id).at(-1)?.payload['text'])).toContain('allaqachon');
  });

  it('a second account cannot take a link that already has a code', async () => {
    const owner = newId();
    const other = newId();
    await webhook(textUpdate({ id: owner }, '/start'));
    await db.user.update({
      where: { telegramId: BigInt(owner) },
      data: { phone: '+998901117777' },
    });
    const nonce = await webStart();
    await webhook(textUpdate({ id: owner }, `/start login_${nonce}`));
    await webhook(textUpdate({ id: other }, `/start login_${nonce}`));
    expect(codeSentTo(other)).toHaveLength(0);
  });
});
