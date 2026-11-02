import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { WebAppLoginResponse } from '@repo/shared';
import { Public } from '../../common/auth/public.decorator';
import { WebAppLoginDto } from './dto/webapp-login.dto';
import { MiniAppAuthService } from './mini-app-auth.service';

@Controller('auth/telegram')
export class AuthWebappController {
  constructor(private readonly miniApp: MiniAppAuthService) {}

  // Public: this call is how a Mini App gets its token. 5/min/IP (rules/10). Not @SkipCsrf:
  // the Mini App client sends X-CSRF-Token (any non-empty value) and the browser adds Origin.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('webapp')
  login(@Body() body: WebAppLoginDto): Promise<WebAppLoginResponse> {
    return this.miniApp.login(body.initData);
  }
}
