import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { authCookieNames } from '@repo/shared';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { cookieValues } from '../../modules/auth/cookie-header';
import { TokenCodec, type TokenPayload } from '../../modules/auth/token-codec';
import { WebSessionService } from '../../modules/auth/web-session.service';
import { UsersService } from '../../modules/users/users.service';
import { CLOCK, type Clock } from '../clock/clock';
import { AppError } from '../exceptions/app-error';
import type { AuthRequest, AuthUser } from './auth-user';
import { IS_PUBLIC_KEY } from './public.decorator';

const BEARER = /^Bearer\s+(\S+)$/i;

// Global guard (registered by AuthModule, after the throttler and before CsrfGuard).
//   Authorization: Bearer <token>  -> Mini App token (typ 'tg')
//   otherwise the access cookie (authCookieNames) -> web token (typ 'web') + a live session family
// Every failure is an AppError, never `return false`: Nest would turn that into a generic
// 403, which this API maps to 404 (D-26) and which is the wrong answer for "log in first".
@Injectable()
export class UserAuthGuard implements CanActivate {
  private readonly accessCookie: string;
  private readonly logger = new Logger('Security');

  constructor(
    private readonly reflector: Reflector,
    private readonly codec: TokenCodec,
    private readonly users: UsersService,
    private readonly sessions: WebSessionService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'NODE_ENV'>,
  ) {
    this.accessCookie = authCookieNames(config.NODE_ENV).access;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const now = this.clock.now();
    const claims = this.readClaims(request, now);
    if (claims === null) throw new AppError('UNAUTHORIZED');

    // A web access token is only as good as its session: logout / "end session" revokes the
    // family, and that must take effect before the 15-minute token runs out.
    if (claims.typ === 'web') {
      const familyId = claims.sid;
      if (familyId === undefined) throw new AppError('UNAUTHORIZED');
      if (!(await this.sessions.isFamilyActive({ familyId, userId: claims.sub }, now))) {
        throw new AppError('UNAUTHORIZED');
      }
    }

    const user = await this.users.findById(claims.sub);
    if (user === null) throw new AppError('UNAUTHORIZED');
    if (user.isBlocked) throw new AppError('USER_BLOCKED');

    const authUser: AuthUser = {
      id: user.id,
      telegramId: user.telegramId,
      channel: claims.typ,
      ...(claims.typ === 'web' && claims.sid !== undefined ? { sessionFamilyId: claims.sid } : {}),
    };
    request.authUser = authUser;
    return true;
  }

  // A presented Bearer token is the only credential considered (no silent fallback to the
  // cookie when it is bad); without one, the cookie.
  private readClaims(request: AuthRequest, now: Date): TokenPayload | null {
    const header = request.headers['authorization'];
    const bearer = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    if (bearer !== undefined) return this.codec.verify(bearer, 'tg', now);

    // A repeated name cannot be attributed to the caller (planted twin cookie): no session.
    if (cookieValues(request.headers['cookie'], this.accessCookie).length > 1) {
      this.logger.warn('security event=DUPLICATE_AUTH_COOKIE cookie=access endpoint=guard');
      return null;
    }
    const cookie = request.cookies?.[this.accessCookie];
    if (typeof cookie === 'string' && cookie !== '') return this.codec.verify(cookie, 'web', now);
    return null;
  }
}
