import {
  Controller,
  Logger,
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
  authCookieNames,
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
import { cookieValues } from './cookie-header';
import { WebSessionService } from './web-session.service';

const MAX_SESSION_ID_LENGTH = 64;
// Logout is @Public and every well-shaped value costs a lookup; a real browser sends one.
export const MAX_LOGOUT_REFRESH_TOKENS = 5;

// Every refresh value the browser sent, empty ones included. More than one means a twin cookie
// (see cookie-header.ts; `__Host-` should make it impossible): the request cannot be attributed.
function refreshCookies(request: AuthRequest, nodeEnv: AppConfig['NODE_ENV']): string[] {
  const name = authCookieNames(nodeEnv).refresh;
  const raw = cookieValues(request.headers['cookie'], name);
  if (raw.length > 0) return raw;
  const parsed = request.cookies?.[name];
  return typeof parsed === 'string' && parsed !== '' ? [parsed] : [];
}

// Refresh, logout and the "my sessions" list. Refresh and logout are @Public because the access
// cookie may already have expired when they are called (the refresh cookie is the credential);
// the CSRF guard still covers them. Owner scoping of the list and of DELETE comes from the
// session only.
@Controller('auth')
export class AuthSessionsController {
  private readonly logger = new Logger('Security');

  constructor(
    private readonly sessions: WebSessionService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'NODE_ENV'>,
  ) {}

  private warnDuplicate(endpoint: string): void {
    this.logger.warn(`security event=DUPLICATE_AUTH_COOKIE cookie=refresh endpoint=${endpoint}`);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() request: AuthRequest,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<SessionUserResponse> {
    const tokens = refreshCookies(request, this.config.NODE_ENV);
    try {
      // Rotating or reuse-revoking would act on a token that may not be the victim's own.
      if (tokens.length > 1) this.warnDuplicate('refresh');
      const token = tokens.length === 1 ? tokens[0] : undefined;
      if (token === undefined || token === '') throw new AppError('UNAUTHORIZED');
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
    const tokens = refreshCookies(request, this.config.NODE_ENV);
    if (tokens.length > 1) this.warnDuplicate('logout');
    // All of them came from this browser, so ending every live one is what the user asked for,
    // but the work is bounded: distinct non-empty values, at most MAX_LOGOUT_REFRESH_TOKENS.
    const distinct = [...new Set(tokens.filter((token) => token !== ''))];
    const dropped = distinct.length - MAX_LOGOUT_REFRESH_TOKENS;
    if (dropped > 0) {
      this.logger.warn(`security event=LOGOUT_COOKIE_VALUES_DROPPED dropped=${String(dropped)}`);
    }
    for (const token of distinct.slice(0, MAX_LOGOUT_REFRESH_TOKENS)) {
      await this.sessions.revokeByRefreshToken(token, this.clock.now());
    }
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
