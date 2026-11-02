import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { UsersService } from '../users/users.service';
import { BotSetupService } from './bot-setup.service';
import { BOT, type TelegramBot } from './bot.provider';
import { installHandlers } from './install-handlers';

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
    private readonly setup: BotSetupService,
  ) {}

  onModuleInit(): void {
    installHandlers(this.bot, {
      users: this.users,
      clock: this.clock,
      config: this.config,
      menu: this.setup,
      log: { warn: (m) => this.logger.warn(m), error: (m) => this.logger.error(m) },
    });
  }
}
