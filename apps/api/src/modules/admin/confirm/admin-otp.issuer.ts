import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminUser } from '@repo/db';
import {
  OTP_CODE_TTL_SEC,
  adminConfirmationBinding,
  scrubSecretsInText,
  tashkentDayKey,
  tashkentNextDayStart,
  type AdminConfirmationBody,
  type AdminConfirmationResponse,
} from '@repo/shared';
import { randomBytes } from 'node:crypto';
import { validationError } from '../../../common/admin/admin-input';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { RedisService } from '../../../infra/redis/redis.service';
import { generateOtpCode, hashOtpCode } from '../../auth/otp-code';
import { TgOutboxEnqueuer } from '../../notifications/tg-outbox.enqueuer';
import { UsersService } from '../../users/users.service';
import { adminOtpJobId, adminOtpKey, adminOtpNonce, adminOtpQuotaKey } from './admin-otp.keys';
import { adminConfirmText, type AdminConfirmSubject } from './admin-otp.message';

/** What the message shows, as the server read it; the user is looked up here. */
export interface AdminOtpSubjectRef {
  readonly amount?: AdminConfirmSubject['amount'];
  readonly userId?: string;
  readonly card?: AdminConfirmSubject['card'];
}

export interface AdminOtpIssue {
  readonly admin: AdminUser;
  readonly sessionId: string;
  readonly body: AdminConfirmationBody;
  readonly serverFlags: readonly string[];
  readonly subject: AdminOtpSubjectRef;
  readonly now: Date;
}

/**
 * Issues the ACTING admin's step-up code (D-63 (4), D-53 (5)): to that admin's own Telegram chat
 * (never OWNER_ALERT_CHAT_ID), in the locale they chose in the bot. At most ADMIN_OTP_DAILY_MAX
 * codes per admin per Asia/Tashkent day (`429` + Retry-After until the next local midnight; the
 * owner CLI is the fallback, D-46). Redis keeps the HMAC hash, the binding and the attempts for
 * OTP_CODE_TTL_SEC; the code itself lives only in the outbox job until it is sent.
 */
@Injectable()
export class AdminOtpIssuer {
  private readonly logger = new Logger('AdminOtp');

  constructor(
    private readonly redis: RedisService,
    private readonly outbox: TgOutboxEnqueuer,
    private readonly users: UsersService,
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, 'OTP_PEPPER' | 'ADMIN_OTP_DAILY_MAX'>,
  ) {}

  async issue(input: AdminOtpIssue): Promise<AdminConfirmationResponse> {
    const user = await this.users.findByTelegramId(input.admin.telegramId);
    // Blocked the bot: the code could never arrive (nothing is counted or stored).
    if (user !== null && user.botBlockedAt !== null)
      throw validationError('otp', 'OTP_UNAVAILABLE');
    await this.countToday(input.admin.id, input.now);

    const challengeId = randomBytes(16).toString('hex');
    const binding = await adminConfirmationBinding({
      body: input.body,
      serverFlags: input.serverFlags,
      adminId: input.admin.id,
      sessionId: input.sessionId,
    });
    const code = generateOtpCode();
    const key = adminOtpKey(challengeId);
    const hash = hashOtpCode(this.config.OTP_PEPPER, adminOtpNonce(challengeId, binding), code);
    try {
      await this.redis.client
        .multi()
        .hset(key, { hash, binding, attempts: '0' })
        .expire(key, OTP_CODE_TTL_SEC)
        .exec();
      const text = adminConfirmText(user?.locale ?? 'uz', {
        code,
        body: input.body,
        serverFlags: input.serverFlags,
        subject: await this.subject(input.subject),
      });
      await this.outbox.enqueueEphemeral(adminOtpJobId(challengeId), {
        chatId: input.admin.telegramId.toString(),
        text,
      });
    } catch (error) {
      await this.discard(challengeId);
      this.logger.warn(`admin code not issued: ${describe(error)}`);
      throw validationError('otp', 'OTP_UNAVAILABLE');
    }
    return { challengeId, expiresInSec: OTP_CODE_TTL_SEC };
  }

  private async subject(ref: AdminOtpSubjectRef): Promise<AdminConfirmSubject> {
    const user = ref.userId === undefined ? null : await this.users.findById(ref.userId);
    return {
      ...(ref.amount === undefined ? {} : { amount: ref.amount }),
      ...(ref.card === undefined ? {} : { card: ref.card }),
      ...(user === null ? {} : { user: { username: user.username, telegramId: user.telegramId } }),
    };
  }

  // Counted before the code is made: a refused issue (over the quota) sends nothing.
  private async countToday(adminId: string, now: Date): Promise<void> {
    const key = adminOtpQuotaKey(adminId, tashkentDayKey(now));
    const resetAt = tashkentNextDayStart(now);
    const result = await this.redis.client
      .multi()
      .incr(key)
      .expireat(key, Math.ceil(resetAt.getTime() / 1000) + 60)
      .exec();
    const count = result?.[0]?.[1];
    if (typeof count !== 'number') throw validationError('otp', 'OTP_UNAVAILABLE');
    if (count > this.config.ADMIN_OTP_DAILY_MAX) {
      const retryAfterSec = (resetAt.getTime() - now.getTime()) / 1000;
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec });
    }
  }

  private async discard(challengeId: string): Promise<void> {
    try {
      await this.outbox.discard(adminOtpJobId(challengeId));
    } catch (error) {
      this.logger.warn(`admin code message not removed: ${describe(error)}`);
    }
    try {
      await this.redis.client.del(adminOtpKey(challengeId));
    } catch (error) {
      this.logger.warn(`admin code challenge not removed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : 'non-error thrown';
  return scrubSecretsInText(raw).slice(0, 200);
}
