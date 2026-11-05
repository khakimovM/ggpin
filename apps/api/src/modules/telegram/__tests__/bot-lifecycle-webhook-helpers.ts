import { inspect } from 'node:util';
import { TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import type { AppConfig } from '../../../config/config.module';
import type { TgOutboxEnqueuer } from '../../notifications/tg-outbox.enqueuer';
import { BotLifecycleService } from '../bot-lifecycle.service';
import { BotSetupService } from '../bot-setup.service';
import { createFakeTelegram } from './fake-telegram-api';

export const WEBHOOK_CONFIG = {
  TELEGRAM_BOT_MODE: 'webhook',
  MINI_APP_URL: 'https://app.example.test/tg',
  TELEGRAM_WEBHOOK_URL: 'https://api.example.test/api/v1/telegram/webhook',
  TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  OWNER_ALERT_CHAT_ID: '555000',
} as unknown as AppConfig;

export function setup(config: AppConfig = WEBHOOK_CONFIG) {
  const fake = createFakeTelegram();
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const service = new BotLifecycleService(fake.bot, config, new BotSetupService(fake.bot, config), {
    enqueue,
  } as unknown as TgOutboxEnqueuer);
  return { fake, enqueue, service };
}

// What Node would print for an unhandled rejection or a log line: every nested property.
export const printed = (value: unknown): string =>
  inspect(value, { depth: Infinity, showHidden: true });
export const TOKEN_SECRET_PART = TEST_BOT_TOKEN.slice(TEST_BOT_TOKEN.indexOf(':') + 1);

// The registration chain (init, setWebhook, setup) is a series of resolved promises; this drains
// it without moving the clock.
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await jest.advanceTimersByTimeAsync(0);
}

export async function bootstrap(service: BotLifecycleService): Promise<void> {
  await service.onApplicationBootstrap();
  await flush();
}
