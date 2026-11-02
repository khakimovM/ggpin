import { Inject, Injectable, Logger } from '@nestjs/common';
import { LOCALES, DEFAULT_LOCALE, type Locale } from '@repo/shared';
import type { BotCommand, MenuButton } from 'grammy/types';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { ChatMenu } from './bot-deps';
import { BOT, type TelegramBot } from './bot.provider';
import { translate } from './i18n/translate';
import { safeErrorText } from './safe-error';

const COMMANDS = ['start', 'shop', 'ref', 'lang', 'help'] as const;

@Injectable()
export class BotSetupService implements ChatMenu {
  private readonly logger = new Logger(BotSetupService.name);

  constructor(
    @Inject(BOT) private readonly bot: TelegramBot,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'MINI_APP_URL'>,
  ) {}

  /** Boot-time setup: commands per language and the default menu button. Never throws. */
  async run(): Promise<void> {
    try {
      for (const locale of LOCALES) {
        await this.bot.api.setMyCommands(this.commands(locale), { language_code: locale });
      }
      await this.bot.api.setMyCommands(this.commands(DEFAULT_LOCALE));
      await this.bot.api.setChatMenuButton({ menu_button: this.defaultMenuButton() });
    } catch (error) {
      this.logger.error(`bot setup failed: ${safeErrorText(error)}`);
    }
  }

  /** Menu button text follows the user's language; skipped when there is no Mini App URL. */
  async setForChat(chatId: number, locale: Locale): Promise<void> {
    const url = this.config.MINI_APP_URL;
    if (url === undefined) return;
    try {
      await this.bot.api.setChatMenuButton({
        chat_id: chatId,
        menu_button: {
          type: 'web_app',
          text: translate(locale, 'bot.menu.button'),
          web_app: { url },
        },
      });
    } catch (error) {
      this.logger.warn(`per-chat menu button failed: ${safeErrorText(error)}`);
    }
  }

  private commands(locale: Locale): BotCommand[] {
    return COMMANDS.map((command) => ({
      command,
      description: translate(locale, `bot.commands.${command}`),
    }));
  }

  // Without MINI_APP_URL (dev without an HTTPS tunnel) no web_app button may exist; resetting
  // to the default also clears one left over from an earlier configuration.
  private defaultMenuButton(): MenuButton {
    const url = this.config.MINI_APP_URL;
    if (url === undefined) return { type: 'default' };
    return {
      type: 'web_app',
      text: translate(DEFAULT_LOCALE, 'bot.menu.button'),
      web_app: { url },
    };
  }
}
