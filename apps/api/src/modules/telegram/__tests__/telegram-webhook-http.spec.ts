import { Logger } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { BOT } from '../bot.provider';
import { TelegramWebhookController } from '../telegram-webhook.controller';

const CONFIG = {
  TELEGRAM_BOT_MODE: 'webhook',
  TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
} as unknown as AppConfig;

// Real Fastify, real HTTP routing and body parsing; only the bot is a stub. This is the level
// the first update after a boot (D-29.5: the webhook is registered in the background) arrives at.
async function startApp(inited: boolean) {
  const handleUpdate = jest.fn().mockResolvedValue(undefined);
  const moduleRef = await Test.createTestingModule({
    controllers: [TelegramWebhookController],
    providers: [
      { provide: BOT, useValue: { isInited: () => inited, handleUpdate } },
      { provide: APP_CONFIG, useValue: CONFIG },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, handleUpdate };
}

const post = (app: NestFastifyApplication) =>
  app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    payload: { update_id: 7 },
  });

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /telegram/webhook over HTTP', () => {
  it('answers 503 { ok: false } before the bot is initialised, so that Telegram retries', async () => {
    const { app, handleUpdate } = await startApp(false);
    try {
      const response = await post(app);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false });
      expect(handleUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('answers 200 { ok: true } and processes the update once the bot is initialised', async () => {
    const { app, handleUpdate } = await startApp(true);
    try {
      const response = await post(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(handleUpdate).toHaveBeenCalledWith({ update_id: 7 });
    } finally {
      await app.close();
    }
  });
});
