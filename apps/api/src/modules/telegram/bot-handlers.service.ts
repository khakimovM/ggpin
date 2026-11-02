import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { OtpLoginService } from '../auth/otp-login.service';
import { WebSessionService } from '../auth/web-session.service';
import { UsersService } from '../users/users.service';
import { BotSetupService } from './bot-setup.service';
import { BOT, type TelegramBot } from './bot.provider';
import { installHandlers } from './install-handlers';
import { LoginContactStore } from './login-contact-store';

// Registers handlers in onModuleInit, i.e. before BotLifecycleService (onApplicationBootstrap)
// starts polling or sets the webhook, so no update can arrive at an empty bot.
@Injectable()
export class BotHandlersService implements OnModuleInit {
  private readonly logger = new Logger('TelegramBot');

  constructor(
    @Inject(BOT) private readonly bot: TelegramBot,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly users: UsersService,
    private readonly login: OtpLoginService,
    private readonly sessions: WebSessionService,
    private readonly loginContact: LoginContactStore,
    private readonly setup: BotSetupService,
  ) {}

  onModuleInit(): void {
    installHandlers(this.bot, {
      users: this.users,
      login: this.login,
      sessions: this.sessions,
      loginContact: this.loginContact,
      clock: this.clock,
      // Only what the bot needs: AppConfig holds every secret.
      config: {
        TELEGRAM_BOT_USERNAME: this.config.TELEGRAM_BOT_USERNAME,
        NODE_ENV: this.config.NODE_ENV,
        MINI_APP_URL: this.config.MINI_APP_URL,
        TELEGRAM_NEWS_CHANNEL_URL: this.config.TELEGRAM_NEWS_CHANNEL_URL,
      },
      menu: this.setup,
      log: { warn: (m) => this.logger.warn(m), error: (m) => this.logger.error(m) },
    });
  }
}
