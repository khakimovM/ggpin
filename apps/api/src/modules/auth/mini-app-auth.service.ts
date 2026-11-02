import { Inject, Injectable, Logger } from '@nestjs/common';
import { MINI_APP_TOKEN_TTL_SEC, parseStartPayload, type WebAppLoginResponse } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { FixedWindowCounter } from '../../infra/redis/fixed-window-counter';
import { toMe } from '../users/entities/me.mapper';
import { UsersService } from '../users/users.service';
import { InitDataVerifier } from './init-data.verifier';
import { TokenCodec } from './token-codec';

/**
 * Mini App logins per Telegram account per window. Counted only for a VERIFIED initData, so a
 * forged one can never use up a victim's budget. Per account because Uzbek mobile carriers put
 * thousands of users behind one IPv4 address (CGNAT), which a per-IP limit would punish.
 */
export const WEBAPP_ACCOUNT_LIMIT = { max: 10, windowSec: 60 } as const;

export const webappLimitKey = (telegramId: number | bigint): string =>
  `rl:webapp:${telegramId.toString()}`;

@Injectable()
export class MiniAppAuthService {
  private readonly logger = new Logger(MiniAppAuthService.name);

  constructor(
    private readonly verifier: InitDataVerifier,
    private readonly users: UsersService,
    private readonly codec: TokenCodec,
    private readonly counter: FixedWindowCounter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Mini App login: verified initData -> find-or-create user -> short-lived bearer token. */
  async login(initData: string): Promise<WebAppLoginResponse> {
    const now = this.clock.now();
    const verified = this.verifier.verify(initData, now);
    await this.enforceAccountLimit(verified.user.id);

    // A `ref_` start_param is only a candidate: UsersService binds it solely when this very
    // login created the user (Q7), so replaying a link on an old account does nothing.
    const start = parseStartPayload(verified.startParam);
    const { user } = await this.users.ensureTelegramUser(
      {
        telegramId: verified.user.id,
        username: verified.user.username,
        firstName: verified.user.firstName,
        lastName: verified.user.lastName,
        languageCode: verified.user.languageCode,
        // Only the photo Telegram signed into initData; never a Bot API getFile URL.
        photoUrl: verified.user.photoUrl,
      },
      { refCode: start.kind === 'ref' ? start.code : undefined, now },
    );
    if (user.isBlocked) throw new AppError('USER_BLOCKED');

    const iat = Math.floor(now.getTime() / 1000);
    const token = this.codec.sign({
      typ: 'tg',
      sub: user.id,
      iat,
      exp: iat + MINI_APP_TOKEN_TTL_SEC,
    });
    return { token, expiresIn: MINI_APP_TOKEN_TTL_SEC, user: toMe(user) };
  }

  private async enforceAccountLimit(telegramId: bigint): Promise<void> {
    let hits: number;
    try {
      hits = await this.counter.hit(webappLimitKey(telegramId), WEBAPP_ACCOUNT_LIMIT.windowSec);
    } catch (error) {
      // initData is already verified and the per-IP throttle still applies: an outage of the
      // counter must not lock every Mini App user out.
      const reason = error instanceof Error ? error.name : 'unknown';
      this.logger.warn(`account rate limit unavailable: ${reason}`);
      return;
    }
    if (hits > WEBAPP_ACCOUNT_LIMIT.max) throw new AppError('RATE_LIMITED');
  }
}
