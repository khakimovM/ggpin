import { Inject, Injectable } from '@nestjs/common';
import { MINI_APP_TOKEN_TTL_SEC, parseStartPayload, type WebAppLoginResponse } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { toMe } from '../users/entities/me.mapper';
import { UsersService } from '../users/users.service';
import { InitDataVerifier } from './init-data.verifier';
import { TokenCodec } from './token-codec';

@Injectable()
export class MiniAppAuthService {
  constructor(
    private readonly verifier: InitDataVerifier,
    private readonly users: UsersService,
    private readonly codec: TokenCodec,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Mini App login: verified initData -> find-or-create user -> short-lived bearer token. */
  async login(initData: string): Promise<WebAppLoginResponse> {
    const now = this.clock.now();
    const verified = this.verifier.verify(initData, now);

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
}
