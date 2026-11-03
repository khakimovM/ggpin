import {
  Body,
  Controller,
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
import { Throttle } from '@nestjs/throttler';
import {
  loginStatusParamsSchema,
  type LoginStartResponse,
  type LoginStatusResponse,
  type SessionUserResponse,
} from '@repo/shared';
import { Public } from '../../common/auth/public.decorator';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { setSessionCookies, type CookieReply } from './auth-cookies';
import { LoginStartDto } from './dto/login-start.dto';
import { LoginVerifyDto } from './dto/login-verify.dto';
import { OtpLoginService } from './otp-login.service';

const MINUTE_MS = 60_000;

// Web login through the bot. All three routes are public (that is how a session begins) and
// rate limited per IP (a flood cap: many users share one CGNAT address, so the budgets are
// generous; the real brute-force guard is the per-nonce cap of OTP_MAX_ATTEMPTS); CSRF still applies to the POSTs (a victim's browser must not be made to
// submit an attacker's nonce and code).
@Controller('auth/telegram')
export class AuthOtpController {
  constructor(
    private readonly otp: OtpLoginService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'NODE_ENV'>,
  ) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('start')
  start(@Body() _body: LoginStartDto): Promise<LoginStartResponse> {
    return this.otp.start(this.clock.now());
  }

  // Polled by the login page, hence the higher budget. A malformed nonce is a 404, not a 400,
  // so the route cannot be used to learn what a valid nonce looks like.
  @Public()
  @Throttle({ default: { limit: 300, ttl: MINUTE_MS } })
  @Get('status/:nonce')
  status(@Param('nonce') nonce: string): Promise<LoginStatusResponse> {
    const params = loginStatusParamsSchema.safeParse({ nonce });
    if (!params.success) throw new AppError('NOT_FOUND');
    return this.otp.status(params.data.nonce, this.clock.now());
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('verify')
  async verify(
    @Body() body: LoginVerifyDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<SessionUserResponse> {
    const login = await this.otp.verify({
      nonce: body.nonce,
      code: body.code,
      now: this.clock.now(),
      userAgent,
      ip,
    });
    setSessionCookies(reply, login, this.config.NODE_ENV);
    return { user: login.user };
  }
}
