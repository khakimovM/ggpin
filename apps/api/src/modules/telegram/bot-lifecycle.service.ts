import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { BotSetupService } from './bot-setup.service';
import { BOT, type TelegramBot } from './bot.provider';
import { safeErrorText } from './safe-error';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

@Injectable()
export class BotLifecycleService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BotLifecycleService.name);
  private polling = false;

  constructor(
    @Inject(BOT) private readonly bot: TelegramBot,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly setup: BotSetupService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { TELEGRAM_BOT_MODE: mode } = this.config;
    if (mode === 'off') return;

    if (mode === 'webhook') {
      const { TELEGRAM_WEBHOOK_URL: url, TELEGRAM_WEBHOOK_SECRET: secret } = this.config;
      if (url === undefined || secret === undefined) {
        throw new Error('TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET are required');
      }
      // handleUpdate needs botInfo; a failure here (bad token, Telegram down) must stop boot.
      await this.bot.init();
      await this.bot.api.setWebhook(url, {
        secret_token: secret,
        allowed_updates: [...ALLOWED_UPDATES],
      });
      await this.setup.run();
      return;
    }

    await this.setup.run();
    this.polling = true;
    // start() resolves only when polling stops, so it must not be awaited.
    this.bot.start({ allowed_updates: [...ALLOWED_UPDATES] }).catch((error: unknown) => {
      this.polling = false;
      this.logger.error(`long polling stopped: ${safeErrorText(error)}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.polling) return;
    this.polling = false;
    await this.bot.stop();
  }
}
