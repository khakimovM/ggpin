import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { BotHandlersService } from './bot-handlers.service';
import { BotLifecycleService } from './bot-lifecycle.service';
import { BotSetupService } from './bot-setup.service';
import { botProvider } from './bot.provider';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  imports: [UsersModule],
  controllers: [TelegramWebhookController],
  providers: [botProvider, BotSetupService, BotHandlersService, BotLifecycleService],
  exports: [botProvider],
})
export class TelegramModule {}
