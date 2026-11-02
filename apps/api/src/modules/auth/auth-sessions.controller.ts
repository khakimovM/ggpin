import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  REFRESH_COOKIE_NAME,
  type LogoutResponse,
  type SessionItem,
  type SessionUserResponse,
} from '@repo/shared';
import type { AuthRequest, AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { clearSessionCookies, setSessionCookies, type CookieReply } from './auth-cookies';
import { WebSessionService } from './web-session.service';

const MAX_SESSION_ID_LENGTH = 64;

function refreshCookie(request: AuthRequest): string | undefined {
  const value = request.cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// Refresh, logout and the "my sessions" list. Refresh and logout are @Public because the access
// cookie may already have expired when they are called (the refresh cookie is the credential);
// the CSRF guard still covers them. Owner scoping of the list and of DELETE comes from the
// session only.
@Controller('auth')
export class AuthSessionsController {
  constructor(
    private readonly sessions: WebSessionService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'NODE_ENV'>,
  ) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() request: AuthRequest,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<SessionUserResponse> {
    const token = refreshCookie(request);
    try {
      if (token === undefined) throw new AppError('UNAUTHORIZED');
      const login = await this.sessions.refresh(token, { userAgent, ip }, this.clock.now());
      setSessionCookies(reply, login, this.config.NODE_ENV);
      return { user: login.user };
    } catch (error) {
      // A dead or stolen session must not leave its cookies behind: the headers set here ride
      // along on the error response the exception filter sends.
      if (error instanceof AppError) clearSessionCookies(reply, this.config.NODE_ENV);
      throw error;
    }
  }

  // Always 200 and always clears the cookies. With a refresh cookie it also ends that session;
  // a Mini App bearer token is stateless, so there is nothing to end.
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<LogoutResponse> {
    const token = refreshCookie(request);
    if (token !== undefined) await this.sessions.revokeByRefreshToken(token, this.clock.now());
    clearSessionCookies(reply, this.config.NODE_ENV);
    return {};
  }

  @Get('sessions')
  list(@CurrentUser() user: AuthUser): Promise<SessionItem[]> {
    return this.sessions.listSessions(user.id, user.sessionFamilyId, this.clock.now());
  }

  // Not defined in docs/04: no body is specified, so it answers `{}` like logout.
  @HttpCode(HttpStatus.OK)
  @Delete('sessions/:id')
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<LogoutResponse> {
    // An id that cannot be one of ours is "not found", same as someone else's.
    if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH) throw new AppError('NOT_FOUND');
    await this.sessions.revokeFamily({ userId: user.id, familyId: id, now: this.clock.now() });
    // Ending the session this very browser uses: drop its cookies too.
    if (id === user.sessionFamilyId) clearSessionCookies(reply, this.config.NODE_ENV);
    return {};
  }
}
