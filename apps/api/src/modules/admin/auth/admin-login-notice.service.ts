import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminUser } from '@repo/db';
import {
  BRAND,
  ownerAlertChatIds,
  tgOutboxJobId,
  type Locale,
  type TgOutboxJob,
} from '@repo/shared';
import { translateLenient, type TranslateParams } from '../../../common/i18n/translate';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { deviceLabel } from '../../auth/device-label';
import { maskIp } from '../../auth/mask-ip';
import { formatTime } from '../../auth/new-login-notice.service';
import { TgOutboxEnqueuer } from '../../notifications/tg-outbox.enqueuer';
import { UsersService } from '../../users/users.service';
import { adminSessionEndCallbackData } from './admin-callbacks';

const NO_VALUE = '–';

export interface AdminLoginNoticeInput {
  readonly admin: AdminUser;
  readonly sessionId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

/**
 * After an admin login committed (D-63 (9)): a "new sign-in to the admin panel" message to the
 * admin, with a button that ends that very session, and an `adminLogin` alert to every
 * OWNER_ALERT_CHAT_ID (D-53, uz like every owner alert). Both go through the existing outbox; a
 * failure is logged and never undoes the login.
 *
 * SECURITY: the texts carry the admin's name and role, a device label from a fixed list (never
 * the raw User-Agent), the masked address and the time. Never the code, the nonce or the token
 * (outbox jobs stay in Redis for days). Every value is HTML-escaped by translate().
 */
@Injectable()
export class AdminLoginNoticeService {
  private readonly logger = new Logger('AdminLoginNotice');

  constructor(
    private readonly outbox: TgOutboxEnqueuer,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'OWNER_ALERT_CHAT_ID'>,
  ) {}

  async loggedIn(input: AdminLoginNoticeInput): Promise<void> {
    await this.safely('admin notice', () => this.toAdmin(input));
    // Each partner separately: one recipient's queue failure must not silence the others.
    for (const chatId of ownerAlertChatIds(this.config.OWNER_ALERT_CHAT_ID)) {
      await this.safely('owner alert', () =>
        this.outbox.enqueue(tgOutboxJobId('alert', 'adminLogin', input.sessionId, chatId), {
          chatId,
          text: this.t('uz', 'alerts.adminLogin', {
            name: input.admin.name,
            role: input.admin.role,
            ...this.facts(input, 'uz'),
          }),
        }),
      );
    }
  }

  private async toAdmin(input: AdminLoginNoticeInput): Promise<void> {
    // The admin's own bot chat; the locale they chose there (uz when they never opened the bot).
    const user = await this.users.findByTelegramId(input.admin.telegramId);
    if (user !== null && user.botBlockedAt !== null) return; // blocked the bot: nobody reads it
    const locale: Locale = user?.locale ?? 'uz';
    const job: TgOutboxJob = {
      chatId: input.admin.telegramId.toString(),
      text: this.t(locale, 'bot.admin.newLogin', {
        brand: BRAND.name,
        ...this.facts(input, locale),
      }),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: this.t(locale, 'bot.login.deny'),
              callback_data: adminSessionEndCallbackData(input.sessionId),
            },
          ],
        ],
      },
    };
    await this.outbox.enqueue(tgOutboxJobId('adminlogin', input.sessionId), job);
  }

  private facts(input: AdminLoginNoticeInput, locale: Locale): TranslateParams {
    return {
      device: deviceLabel(input.userAgent) ?? this.t(locale, 'bot.session.unknownDevice'),
      ip: maskIp(input.ip) ?? NO_VALUE,
      time: formatTime(input.now, locale),
    };
  }

  private t(locale: Locale, key: string, params: TranslateParams = {}): string {
    return translateLenient(locale, key, params, (problem) => {
      this.logger.warn(`translation problem: ${problem.message}`);
    });
  }

  private async safely(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      // Name only: an error message from Redis may quote the connection string or the payload.
      this.logger.warn(`${what} not queued: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
}
