import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  describeErrorForLog,
  formatMoney,
  OTP_CODE_TTL_SEC,
  ownerAlertChatIds,
} from '@repo/shared';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { RedisService } from '../../../infra/redis/redis.service';
import { generateOtpCode, hashOtpCode } from '../../../modules/auth/otp-code';
import { TgOutboxEnqueuer } from '../../../modules/notifications/tg-outbox.enqueuer';
import { translate } from '../../i18n/translate';
import { validationError } from '../admin-input';
import { otpBinding, otpNonce, ownerOtpJobId, ownerOtpKey, type OwnerOtpScope } from './owner-otp';

// Owner alerts are written in Uzbek (docs/09: the owner's tools are Uzbek only).
const OWNER_LOCALE = 'uz' as const;

export interface OwnerChallenge {
  /** Kept in the CLI process memory only: never printed, logged or stored as is. */
  readonly challengeId: string;
  readonly expiresInSec: number;
}

/**
 * Issues the owner's code for one money action (D-46) and sends it to the PRIMARY id of
 * OWNER_ALERT_CHAT_ID (the first of the list, D-53): one code reaches one person, while the
 * alerts themselves go to every partner. The owner's own user chat, where every owner alert
 * (adminAction too) already goes. Not
 * ADMIN_TELEGRAM_IDS: that is the login allowlist of every admin, operators included, and an
 * operator must not be able to confirm the owner's money action.
 *
 * Redis keeps the HMAC hash, the binding and the attempts for OTP_CODE_TTL_SEC; the code is in
 * the outbox job only until it is sent (removeOnComplete/removeOnFail) and the CLI removes the
 * job when it is done with the challenge (`discard`), whatever the outcome.
 */
@Injectable()
export class OwnerOtpIssuer {
  private readonly logger = new Logger('OwnerOtp');

  constructor(
    private readonly redis: RedisService,
    private readonly outbox: TgOutboxEnqueuer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(scope: OwnerOtpScope): Promise<OwnerChallenge> {
    const [chatId] = ownerAlertChatIds(this.config.OWNER_ALERT_CHAT_ID);
    if (chatId === undefined) throw validationError('otp', 'OTP_UNAVAILABLE');
    const challengeId = randomBytes(16).toString('hex');
    const binding = otpBinding(scope);
    const code = generateOtpCode();
    const key = ownerOtpKey(challengeId);
    const hash = hashOtpCode(this.config.OTP_PEPPER, otpNonce(challengeId, binding), code);
    try {
      await this.redis.client
        .multi()
        .hset(key, { hash, binding, attempts: '0' })
        .expire(key, OTP_CODE_TTL_SEC)
        .exec();
      const text = translate(OWNER_LOCALE, 'alerts.ownerConfirm.code', {
        code,
        action: scope.action,
        amount: translate(OWNER_LOCALE, 'common.money.uzs', {
          amount: formatMoney(scope.amountTiyin, OWNER_LOCALE),
        }),
        target: scope.target,
        flags: scope.flags === undefined || scope.flags === '' ? '-' : scope.flags,
      });
      await this.outbox.enqueueEphemeral(ownerOtpJobId(challengeId), { chatId, text });
    } catch (error) {
      await this.discard(challengeId);
      this.logger.warn(`owner code not issued: ${describe(error)}`);
      throw validationError('otp', 'OTP_UNAVAILABLE');
    }
    return { challengeId, expiresInSec: OTP_CODE_TTL_SEC };
  }

  /** Best effort: the outbox job (if not sent yet) and the challenge are removed. */
  async discard(challengeId: string): Promise<void> {
    try {
      await this.outbox.discard(ownerOtpJobId(challengeId));
    } catch (error) {
      this.logger.warn(`owner code message not removed: ${describe(error)}`);
    }
    try {
      await this.redis.client.del(ownerOtpKey(challengeId));
    } catch (error) {
      this.logger.warn(`owner code challenge not removed: ${describe(error)}`);
    }
  }
}

// An error message never holds the code (it is not part of any Redis or queue error), but it may
// quote the Redis URL: scrubbed and cut like every other Redis error in the API (and a database
// error is described from names only, review M1).
function describe(error: unknown): string {
  return describeErrorForLog(error, 200);
}
