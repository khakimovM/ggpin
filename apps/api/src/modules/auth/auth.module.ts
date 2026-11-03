import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from '../../common/auth/csrf.guard';
import { UserAuthGuard } from '../../common/auth/user-auth.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AuthOtpController } from './auth-otp.controller';
import { AuthSessionsController } from './auth-sessions.controller';
import { AuthWebappController } from './auth-webapp.controller';
import { InitDataVerifier } from './init-data.verifier';
import { LoginRequestRepository } from './login-request.repository';
import { MiniAppAuthService } from './mini-app-auth.service';
import { NewLoginNoticeService } from './new-login-notice.service';
import { OtpLoginService } from './otp-login.service';
import { TokenCodec } from './token-codec';
import { WebSessionRepository } from './web-session.repository';
import { WebSessionService } from './web-session.service';

// ORDER MATTERS. Nest runs APP_GUARDs in the order they were registered, which follows module
// order: AppModule imports HttpPipelineModule (ThrottlerGuard) BEFORE this module, and the two
// guards below are listed in the order they must run:
//   1. ThrottlerGuard  (flood protection first, even for unauthenticated requests)
//   2. UserAuthGuard   (who is calling; sets request.authUser)
//   3. CsrfGuard       (needs to know whether the caller is Bearer-authenticated)
// common/__tests__/guard-order.e2e-spec.ts proves it by behaviour.
@Module({
  imports: [UsersModule, NotificationsModule],
  controllers: [AuthWebappController, AuthOtpController, AuthSessionsController],
  providers: [
    TokenCodec,
    InitDataVerifier,
    MiniAppAuthService,
    WebSessionRepository,
    WebSessionService,
    LoginRequestRepository,
    NewLoginNoticeService,
    OtpLoginService,
    { provide: APP_GUARD, useClass: UserAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  // OtpLoginService is the bot's door into login requests (issueCode / deny / releaseCode);
  // WebSessionService adds endSessionFromBot.
  exports: [TokenCodec, WebSessionService, OtpLoginService],
})
export class AuthModule {}
