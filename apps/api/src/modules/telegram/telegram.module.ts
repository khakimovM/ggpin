import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { BotHandlersService } from './bot-handlers.service';
import { BotLifecycleService } from './bot-lifecycle.service';
import { BotSetupService } from './bot-setup.service';
import { botProvider } from './bot.provider';
import { LoginContactStore } from './login-contact-store';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  imports: [UsersModule, AuthModule, NotificationsModule],
  controllers: [TelegramWebhookController],
  providers: [
    botProvider,
    LoginContactStore,
    BotSetupService,
    BotHandlersService,
    BotLifecycleService,
  ],
  exports: [botProvider],
})
export class TelegramModule {}
