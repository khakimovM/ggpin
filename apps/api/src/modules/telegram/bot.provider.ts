import type { Provider } from '@nestjs/common';
import { Bot } from 'grammy';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { BotContext } from './bot-context';

export const BOT = Symbol('TELEGRAM_BOT');
export type TelegramBot = Bot<BotContext>;

// One Bot for the process. Tests override this provider with a Bot built from a fake `botInfo`
// and an API transformer (see __tests__/fake-telegram-api.ts), so nothing reaches Telegram.
export const botProvider: Provider = {
  provide: BOT,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): TelegramBot => new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN),
};
