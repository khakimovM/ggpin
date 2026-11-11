import { Inject, Injectable } from '@nestjs/common';
import type { TgOutboxJob } from '@repo/shared';
import { Api } from 'grammy';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { TgOutboxSender } from './tg-outbox.sender';

/**
 * Production transport: grammY's bare `Api` (no Bot, no polling, no updates). Retries and
 * rate limits are the consumer's job, so no auto-retry plugin is installed here. The token
 * stays inside the `Api` instance; grammY HttpError messages may quote the API URL, which is
 * why the consumer scrubs error text before logging.
 */
@Injectable()
export class GrammyTgOutboxSender implements TgOutboxSender {
  private readonly api: Api;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.api = new Api(config.TELEGRAM_BOT_TOKEN);
  }

  async send(job: TgOutboxJob): Promise<void> {
    await this.api.sendMessage(job.chatId, job.text, {
      parse_mode: 'HTML',
      // Whatever a message contains, Telegram must not fetch and show a preview of a link in it.
      link_preview_options: { is_disabled: true },
      // The job schema guarantees an inline keyboard of callback_data / url / web_app buttons, and
      // the consumer has checked that url and web_app open our own origins.
      ...(job.replyMarkup === undefined ? {} : { reply_markup: job.replyMarkup }),
      ...(job.disableNotification === undefined
        ? {}
        : { disable_notification: job.disableNotification }),
    });
  }
}
