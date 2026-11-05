import type { AppConfig } from '../../../config/config.module';
import type { TgOutboxEnqueuer } from '../../notifications/tg-outbox.enqueuer';
import { BotLifecycleService } from '../bot-lifecycle.service';
import { BotSetupService } from '../bot-setup.service';
import { createFakeTelegram } from './fake-telegram-api';

const CONFIG = {
  TELEGRAM_BOT_MODE: 'polling',
  MINI_APP_URL: 'https://app.example.test/tg',
} as unknown as AppConfig;

function fakeOutbox() {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  return { enqueue, outbox: { enqueue } as unknown as TgOutboxEnqueuer };
}

function lifecycle() {
  const fake = createFakeTelegram();
  // start() would begin real long polling; what matters here is whether it is reached.
  const start = jest.spyOn(fake.bot, 'start').mockResolvedValue(undefined);
  const service = new BotLifecycleService(
    fake.bot,
    CONFIG,
    new BotSetupService(fake.bot, CONFIG),
    fakeOutbox().outbox,
  );
  return { fake, start, service };
}

describe('BotLifecycleService polling mode', () => {
  it('checks getWebhookInfo first, then sets the bot up and starts polling when no webhook is set', async () => {
    const { fake, start, service } = lifecycle();
    await service.onApplicationBootstrap();
    expect(fake.calls[0]?.method).toBe('getWebhookInfo');
    expect(fake.callsOf('setMyCommands').length).toBeGreaterThan(0);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('refuses to poll when the token has a webhook: nothing is changed, the error says to use a separate bot', async () => {
    const { fake, start, service } = lifecycle();
    fake.setWebhookUrl('https://api.example.test/api/v1/telegram/webhook');
    const failure: unknown = await service.onApplicationBootstrap().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('separate bot token');
    expect(message).not.toContain('api.example.test'); // the webhook URL is not echoed
    expect(start).not.toHaveBeenCalled();
    expect(fake.calls.map((c) => c.method)).toEqual(['getWebhookInfo']);
  });

  it('refuses to poll when the webhook cannot be checked', async () => {
    const { fake, start, service } = lifecycle();
    fake.failMethod('getWebhookInfo');
    await expect(service.onApplicationBootstrap()).rejects.toThrow(/could not check/);
    expect(start).not.toHaveBeenCalled();
    expect(fake.callsOf('setMyCommands')).toHaveLength(0);
  });

  it('does nothing in mode off', async () => {
    const fake = createFakeTelegram();
    const off = { ...CONFIG, TELEGRAM_BOT_MODE: 'off' } as unknown as AppConfig;
    await new BotLifecycleService(
      fake.bot,
      off,
      new BotSetupService(fake.bot, off),
      fakeOutbox().outbox,
    ).onApplicationBootstrap();
    expect(fake.calls).toHaveLength(0);
  });
});
