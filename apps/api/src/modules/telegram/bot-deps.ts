import type { Locale } from '@repo/shared';
import type { Clock } from '../../common/clock/clock';
import type { OtpLoginService } from '../auth/otp-login.service';
import type { UsersService } from '../users/users.service';
import type { KeyboardConfig } from './keyboards';

export interface BotConfig extends KeyboardConfig {
  readonly TELEGRAM_BOT_USERNAME: string;
  readonly NODE_ENV: 'development' | 'test' | 'production';
}

export interface BotLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** Sets the per-chat menu button (localized text); never throws. */
export interface ChatMenu {
  setForChat(chatId: number, locale: Locale): Promise<void>;
}

/** Which login link an account was asked to share its phone for (one per account). */
export interface PendingLoginStore {
  remember(telegramId: bigint, nonce: string): Promise<void>;
  /** Atomically reads and deletes: at most one caller gets the nonce. */
  take(telegramId: bigint): Promise<string | null>;
}

// Everything the handlers may use. Handlers get domain services only: no Prisma, no money.
export interface BotDeps {
  readonly users: Pick<
    UsersService,
    'ensureTelegramUser' | 'updateLocale' | 'markBotBlocked' | 'clearBotBlocked' | 'setPhone'
  >;
  readonly login: Pick<OtpLoginService, 'issueCode' | 'deny' | 'status'>;
  readonly loginContact: PendingLoginStore;
  readonly clock: Clock;
  readonly config: BotConfig;
  readonly menu: ChatMenu;
  readonly log: BotLogger;
}
