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
      await this.registerWebhook(url, secret);
      await this.setup.run();
      return;
    }

    // grammY's start() deletes the webhook. With the production token that would silently switch
    // the live bot off, so a dev process must find out first and refuse.
    await this.refuseIfWebhookIsSet();
    await this.setup.run();
    this.polling = true;
    // start() resolves only when polling stops, so it must not be awaited.
    this.bot.start({ allowed_updates: [...ALLOWED_UPDATES] }).catch((error: unknown) => {
      this.polling = false;
      this.logger.error(`long polling stopped: ${safeErrorText(error)}`);
    });
  }

  // handleUpdate needs botInfo; a failure here (bad token, Telegram down) must stop boot. grammY
  // errors carry the request (GrammyError.payload holds secret_token, HttpError.error the Bot API
  // URL with the token) and an unhandled boot rejection is printed with util.inspect, so only a
  // scrubbed one-liner leaves here, deliberately without the original error as its cause.
  private async registerWebhook(url: string, secret: string): Promise<void> {
    let failure: string | null = null;
    try {
      await this.bot.init();
      await this.bot.api.setWebhook(url, {
        secret_token: secret,
        allowed_updates: [...ALLOWED_UPDATES],
      });
    } catch (error) {
      failure = safeErrorText(error);
    }
    if (failure !== null) throw new Error(`webhook setup failed: ${failure}`);
  }

  private async refuseIfWebhookIsSet(): Promise<void> {
    let url: string | null = null;
    let failure = '';
    try {
      url = (await this.bot.api.getWebhookInfo()).url ?? '';
    } catch (error) {
      failure = safeErrorText(error);
    }
    // Cannot prove there is no webhook, so do not risk taking it down.
    if (url === null)
      throw new Error(`could not check the bot's webhook before polling: ${failure}`);
    if (url !== '') {
      throw new Error(
        'TELEGRAM_BOT_MODE=polling would delete the webhook this bot token is serving (a live bot is using it). Use a separate bot token from @BotFather for development. If this IS your dev bot and the webhook is a leftover, remove it once with the Bot API method deleteWebhook.',
      );
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.polling) return;
    this.polling = false;
    await this.bot.stop();
  }
}
