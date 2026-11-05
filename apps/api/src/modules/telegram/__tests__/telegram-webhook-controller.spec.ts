import { Logger } from '@nestjs/common';
import { TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import type { AppConfig } from '../../../config/config.module';
import type { TelegramBot } from '../bot.provider';
import { TelegramWebhookController } from '../telegram-webhook.controller';

const CONFIG = {
  TELEGRAM_BOT_MODE: 'webhook',
  TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
} as unknown as AppConfig;

function setup(inited: boolean) {
  const handleUpdate = jest.fn().mockResolvedValue(undefined);
  const bot = { isInited: () => inited, handleUpdate } as unknown as TelegramBot;
  const status = jest.fn();
  return {
    handleUpdate,
    status,
    controller: new TelegramWebhookController(bot, CONFIG),
    receive: (controller: TelegramWebhookController) =>
      controller.receive(TEST_WEBHOOK_SECRET, { update_id: 7 }, { status }),
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('TelegramWebhookController before the bot is initialised (D-29.5)', () => {
  it('answers 503 and does not process the update, so Telegram retries it', async () => {
    const { controller, receive, status, handleUpdate } = setup(false);
    await expect(receive(controller)).resolves.toEqual({ ok: false });
    expect(status).toHaveBeenCalledWith(503);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('processes the update and answers 200 once the bot is initialised', async () => {
    const { controller, receive, status, handleUpdate } = setup(true);
    await expect(receive(controller)).resolves.toEqual({ ok: true });
    expect(status).not.toHaveBeenCalled();
    expect(handleUpdate).toHaveBeenCalledWith({ update_id: 7 });
  });

  it('a wrong secret is still a 404 first, whatever the bot state: scanners learn nothing', async () => {
    const { controller, status } = setup(false);
    await expect(
      controller.receive('x'.repeat(TEST_WEBHOOK_SECRET.length), { update_id: 7 }, { status }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(status).not.toHaveBeenCalled();
  });
});
