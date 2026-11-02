import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from '../../common/auth/csrf.guard';
import { UserAuthGuard } from '../../common/auth/user-auth.guard';
import { UsersModule } from '../users/users.module';
import { AuthWebappController } from './auth-webapp.controller';
import { InitDataVerifier } from './init-data.verifier';
import { MiniAppAuthService } from './mini-app-auth.service';
import { TokenCodec } from './token-codec';
import { WebSessionRepository } from './web-session.repository';

// ORDER MATTERS. Nest runs APP_GUARDs in the order they were registered, which follows module
// order: AppModule imports HttpPipelineModule (ThrottlerGuard) BEFORE this module, and the two
// guards below are listed in the order they must run:
//   1. ThrottlerGuard  (flood protection first, even for unauthenticated requests)
//   2. UserAuthGuard   (who is calling; sets request.authUser)
//   3. CsrfGuard       (needs to know whether the caller is Bearer-authenticated)
// common/__tests__/guard-order.e2e-spec.ts proves it by behaviour.
@Module({
  imports: [UsersModule],
  controllers: [AuthWebappController],
  providers: [
    TokenCodec,
    InitDataVerifier,
    MiniAppAuthService,
    WebSessionRepository,
    { provide: APP_GUARD, useClass: UserAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  // S6 (web OTP, refresh, sessions) signs access tokens and extends the session repository.
  exports: [TokenCodec, WebSessionRepository],
})
export class AuthModule {}
