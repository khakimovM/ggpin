import { Injectable, Logger } from '@nestjs/common';
import type { User } from '@repo/db';
import {
  BRAND,
  sessionEndCallbackData,
  tgOutboxJobId,
  type Locale,
  type TgOutboxJob,
} from '@repo/shared';
import { translateLenient, type TranslateParams } from '../../common/i18n/translate';
import { TgOutboxEnqueuer } from '../notifications/tg-outbox.enqueuer';
import { deviceLabel } from './device-label';
import { maskIp } from './mask-ip';
import type { SessionMeta } from './web-session.service';

const NO_VALUE = '–';
// Uzbek mobile users read Tashkent time whatever the server clock says.
const TIME_ZONE = 'Asia/Tashkent';

export interface NewLoginNoticeInput {
  readonly user: Pick<User, 'telegramId' | 'locale' | 'botBlockedAt'>;
  readonly familyId: string;
  readonly meta: SessionMeta;
  readonly now: Date;
}

/**
 * "New sign-in to your account" message with a button that ends that very session. Sent after
 * the login committed; it can never fail the login.
 *
 * SECURITY: the text and the button carry the masked address, a device label chosen from a fixed list (never the raw user agent, which
 * the client controls and Telegram would auto-link), the time
 * and the session family id, and nothing else. Never the code or the nonce (jobs live in Redis
 * for days, see TgOutboxEnqueuer). The family id in the callback is not a secret: the bot only
 * acts on it for the account that owns the family (WebSessionService.endSessionFromBot).
 */
@Injectable()
export class NewLoginNoticeService {
  private readonly logger = new Logger('NewLoginNotice');

  constructor(private readonly outbox: TgOutboxEnqueuer) {}

  async send(input: NewLoginNoticeInput): Promise<void> {
    const { user, familyId } = input;
    // The user blocked the bot: there is nobody to read it.
    if (user.botBlockedAt !== null) return;
    try {
      await this.outbox.enqueue(newLoginJobId(familyId), this.build(input));
    } catch (error) {
      // Name only: an error message from Redis may quote the connection string or the payload.
      this.logger.warn(
        `new-login notice not queued: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  private build(input: NewLoginNoticeInput): TgOutboxJob {
    const { user, familyId, meta, now } = input;
    const locale: Locale = user.locale;
    const t = (key: string, params: TranslateParams = {}): string =>
      translateLenient(locale, key, params, (problem) => {
        this.logger.warn(`translation problem: ${problem.message}`);
      });

    const device = deviceLabel(meta.userAgent) ?? t('bot.session.unknownDevice');
    return {
      chatId: user.telegramId.toString(),
      text: t('bot.session.newLogin', {
        brand: BRAND.name,
        device,
        ip: maskIp(meta.ip) ?? NO_VALUE,
        time: formatTime(now, locale),
      }),
      replyMarkup: {
        inline_keyboard: [
          [{ text: t('bot.session.end'), callback_data: sessionEndCallbackData(familyId) }],
        ],
      },
    };
  }
}

// BullMQ job ids take [A-Za-z0-9_] segments here; a UUID without its dashes is 32 hex chars
// and stays unique per session.
export function newLoginJobId(familyId: string): string {
  return tgOutboxJobId('newlogin', familyId.replaceAll('-', ''));
}

function formatTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TIME_ZONE,
  }).format(date);
}
