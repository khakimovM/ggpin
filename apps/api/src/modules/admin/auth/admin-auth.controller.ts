import {
  Body,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  ADMIN_ROLES,
  AdminLoginStatusParamsSchema,
  type AdminLoginStartResponse,
  type AdminLoginStatusResponse,
  type AdminLoginVerifyResponse,
  type AdminLogoutResponse,
  type AdminMeResponse,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { AdminController } from '../common/admin-controller.decorator';
import { AdminPublic } from '../common/admin-public.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { AdminRoles } from '../common/admin-role.decorator';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { clearAdminCookie, setAdminCookie, type AdminCookieReply } from './admin-cookies';
import { AdminLoginService } from './admin-login.service';
import { toAdminMe, toAdminSelf } from './admin-me.mapper';
import { AdminSessionService } from './admin-session.service';
import { AdminLoginStartDto } from './dto/admin-login-start.dto';
import { AdminLoginVerifyDto } from './dto/admin-login-verify.dto';

const MINUTE_MS = 60_000;
// The login routes' own per-IP budgets (docs/04 «Auth»); they do not count against the
// anonymous 60/min of the session routes. The global throttler applies them (opted back in).
const LOGIN_ROUTE = { default: false } as const;

// `/api/v1/admin/auth/*`. start / status / verify are open (that is how a session begins) but
// still pass AdminCsrfGuard (Origin, Sec-Fetch-*, CSRF header on POST); logout and me need a
// live admin session of any role.
@AdminController('auth')
export class AdminAuthController {
  constructor(
    private readonly login: AdminLoginService,
    private readonly sessions: AdminSessionService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG)
    private readonly config: Pick<
      AppConfig,
      'NODE_ENV' | 'ADMIN_OPERATOR_REFUND_MAX_TIYIN' | 'ADMIN_CONFIRM_THRESHOLD_TIYIN'
    >,
  ) {}

  @AdminPublic()
  @SkipThrottle(LOGIN_ROUTE)
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('start')
  start(
    @Body() _body: AdminLoginStartDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<AdminLoginStartResponse> {
    return this.login.start(this.clock.now(), { ip, userAgent: userAgent ?? null });
  }

  // Polled by the login page. A malformed nonce is a 404, not a 400: the route must not teach
  // what a valid nonce looks like.
  @AdminPublic()
  @SkipThrottle(LOGIN_ROUTE)
  @Throttle({ default: { limit: 300, ttl: MINUTE_MS } })
  @Get('status/:nonce')
  status(@Param('nonce') nonce: string): Promise<AdminLoginStatusResponse> {
    const params = AdminLoginStatusParamsSchema.safeParse({ nonce });
    if (!params.success) throw new AppError('NOT_FOUND');
    return this.login.status(params.data.nonce, this.clock.now());
  }

  @AdminPublic()
  @SkipThrottle(LOGIN_ROUTE)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('verify')
  async verify(
    @Body() body: AdminLoginVerifyDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: AdminCookieReply,
  ): Promise<AdminLoginVerifyResponse> {
    const login = await this.login.verify({
      nonce: body.nonce,
      code: body.code,
      now: this.clock.now(),
      ip,
      userAgent: userAgent ?? null,
    });
    setAdminCookie(reply, login.token, this.config.NODE_ENV);
    return { admin: toAdminSelf(login.admin) };
  }

  @AdminRoles(...ADMIN_ROLES)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: AdminCookieReply,
  ): Promise<AdminLogoutResponse> {
    await this.sessions.logout(principal, ip, this.clock.now());
    clearAdminCookie(reply, this.config.NODE_ENV);
    return {};
  }

  @AdminRoles(...ADMIN_ROLES)
  @Get('me')
  me(@CurrentAdmin() principal: AdminPrincipal): AdminMeResponse {
    return toAdminMe(principal, this.config);
  }
}
