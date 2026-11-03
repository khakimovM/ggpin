import { inspect } from 'node:util';
import { HttpError } from 'grammy';
import { TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import type { AppConfig } from '../../../config/config.module';
import { BotLifecycleService } from '../bot-lifecycle.service';
import { BotSetupService } from '../bot-setup.service';
import { createFakeTelegram } from './fake-telegram-api';

const CONFIG = {
  TELEGRAM_BOT_MODE: 'polling',
  MINI_APP_URL: 'https://app.example.test/tg',
} as unknown as AppConfig;

function lifecycle() {
  const fake = createFakeTelegram();
  // start() would begin real long polling; what matters here is whether it is reached.
  const start = jest.spyOn(fake.bot, 'start').mockResolvedValue(undefined);
  const service = new BotLifecycleService(fake.bot, CONFIG, new BotSetupService(fake.bot, CONFIG));
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
    ).onApplicationBootstrap();
    expect(fake.calls).toHaveLength(0);
  });
});

const WEBHOOK_CONFIG = {
  ...CONFIG,
  TELEGRAM_BOT_MODE: 'webhook',
  TELEGRAM_WEBHOOK_URL: 'https://api.example.test/api/v1/telegram/webhook',
  TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
} as unknown as AppConfig;

function webhookLifecycle() {
  const fake = createFakeTelegram();
  const service = new BotLifecycleService(
    fake.bot,
    WEBHOOK_CONFIG,
    new BotSetupService(fake.bot, WEBHOOK_CONFIG),
  );
  return { fake, service };
}

// What Node would print for an unhandled boot rejection: every nested property, at any depth.
const printed = (value: unknown): string => inspect(value, { depth: Infinity, showHidden: true });
const TOKEN_SECRET_PART = TEST_BOT_TOKEN.slice(TEST_BOT_TOKEN.indexOf(':') + 1);

describe('BotLifecycleService webhook mode', () => {
  it('sets the webhook with the secret and the allowed updates, then sets the bot up', async () => {
    const { fake, service } = webhookLifecycle();
    await service.onApplicationBootstrap();
    expect(fake.callsOf('setWebhook')[0]?.payload).toMatchObject({
      url: 'https://api.example.test/api/v1/telegram/webhook',
      secret_token: TEST_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });
    expect(fake.callsOf('setMyCommands').length).toBeGreaterThan(0);
  });

  it('a Bot API error from setWebhook stops boot, and the thrown error does not carry secret_token', async () => {
    const { fake, service } = webhookLifecycle();
    fake.failMethod('setWebhook');
    const failure: unknown = await service.onApplicationBootstrap().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(printed(failure)).toContain('webhook setup failed');
    expect(printed(failure)).not.toContain(TEST_WEBHOOK_SECRET);
    expect(fake.callsOf('setMyCommands')).toHaveLength(0);
  });

  it('a network error from setWebhook stops boot, and the thrown error does not carry the bot token', async () => {
    const { fake, service } = webhookLifecycle();
    // grammY's own shape: a safe message, the underlying error (with the token URL) as .error.
    const network = new HttpError(
      "Network request for 'setWebhook' failed!",
      new Error(`request to http://telegram.invalid/bot${TEST_BOT_TOKEN}/setWebhook failed`),
    );
    expect(printed(network)).toContain(TOKEN_SECRET_PART); // control: the raw error leaks it
    fake.bot.api.config.use((prev, method, payload, signal) =>
      method === 'setWebhook' ? Promise.reject(network) : prev(method, payload, signal),
    );
    const failure: unknown = await service.onApplicationBootstrap().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(printed(failure)).toContain('webhook setup failed');
    expect(printed(failure)).not.toContain(TOKEN_SECRET_PART);
  });
});
