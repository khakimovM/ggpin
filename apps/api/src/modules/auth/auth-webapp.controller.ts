import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { WebAppLoginResponse } from '@repo/shared';
import { Public } from '../../common/auth/public.decorator';
import { WebAppLoginDto } from './dto/webapp-login.dto';
import { MiniAppAuthService } from './mini-app-auth.service';

@Controller('auth/telegram')
export class AuthWebappController {
  constructor(private readonly miniApp: MiniAppAuthService) {}

  // Public: this call is how a Mini App gets its token. 120/min/IP is only a flood cap (CGNAT:
  // thousands of users share an address); the real limit is 10/min per Telegram account, counted
  // in MiniAppAuthService after initData is verified. Not @SkipCsrf: the Mini App client sends
  // X-CSRF-Token (any non-empty value) and the browser adds Origin.
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('webapp')
  login(@Body() body: WebAppLoginDto): Promise<WebAppLoginResponse> {
    return this.miniApp.login(body.initData);
  }
}
