import { Module, type OnModuleInit } from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import { NotificationsModule } from '../notifications/notifications.module';
import { PricingModule } from '../pricing/pricing.module';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminAccountsService } from './admins/admin-accounts.service';
import { AdminLifecycleService } from './admins/admin-lifecycle.service';
import { AdminUsersRepository } from './admins/admin-users.repository';
import { AdminAuthController } from './auth/admin-auth.controller';
import { AdminLoginNoticeService } from './auth/admin-login-notice.service';
import { AdminLoginOriginStore } from './auth/admin-login-origin.store';
import { AdminLoginRequestRepository } from './auth/admin-login-request.repository';
import { AdminLoginService } from './auth/admin-login.service';
import { AdminSessionRepository } from './auth/admin-session.repository';
import { AdminSessionService } from './auth/admin-session.service';
import { AdminCsrfGuard } from './common/admin-csrf.guard';
import { AdminFallbackController } from './common/admin-fallback.controller';
import { registerAdminNotFoundGate } from './common/admin-not-found.hook';
import { AdminRequestGate } from './common/admin-request-gate';
import { AdminThrottle } from './common/admin-throttle';
import { AdminGuard } from './common/admin.guard';
import { ADMIN_READ_CONTROLLERS, ADMIN_READ_PROVIDERS } from './read/admin-read.providers';
import { ADMIN_WRITE_CONTROLLERS, ADMIN_WRITE_PROVIDERS } from './write/admin-write.providers';

// The admin panel's API (`/api/v1/admin/*`, docs/04 «Admin», phase 9). Prisma, Redis, Clock and
// config come from global modules.
//
// ORDER MATTERS. The two APP_GUARDs run after the throttler and the user guards (AppModule
// imports this module after HttpPipelineModule and AuthModule), and in the order listed:
//   1. AdminCsrfGuard  (Origin / Sec-Fetch-* / CSRF header: the request's shape, no lookup)
//   2. AdminGuard      (session -> isActive -> allowlist -> limits -> role)
// Both pass every non-admin route untouched; UserAuthGuard and CsrfGuard pass every admin route
// untouched (common/auth/admin-route.ts decides, from the matched handler's declared path).
//
// The bot (TelegramModule) imports this module for the admin login and session ends; this module
// never imports the bot: its messages go through the tg-outbox.
@Module({
  imports: [UsersModule, NotificationsModule, WalletModule, PaymentsModule, PricingModule],
  // AdminFallbackController claims every unknown /admin/* path the router can match (real routes
  // win); registerAdminNotFoundGate covers what the router still sends to its not-found handler.
  controllers: [
    AdminAuthController,
    ...ADMIN_READ_CONTROLLERS,
    ...ADMIN_WRITE_CONTROLLERS,
    AdminFallbackController,
  ],
  providers: [
    // The owner CLI's account services (admin:*); here too so the app that serves the panel
    // resolves the same instances (the e2e suites drive the CLI against it).
    AdminAccountsService,
    AdminLifecycleService,
    AdminUsersRepository,
    AdminSessionRepository,
    AdminSessionService,
    AdminLoginRequestRepository,
    AdminLoginOriginStore,
    AdminLoginNoticeService,
    AdminLoginService,
    AdminThrottle,
    AdminRequestGate,
    ...ADMIN_READ_PROVIDERS,
    ...ADMIN_WRITE_PROVIDERS,
    { provide: APP_GUARD, useClass: AdminCsrfGuard },
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
  exports: [AdminLoginService, AdminSessionService],
})
export class AdminModule implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost<FastifyAdapter>,
    private readonly gate: AdminRequestGate,
  ) {}

  // During app.init(), before Fastify is ready: the not-found handler takes its hooks then.
  onModuleInit(): void {
    registerAdminNotFoundGate(this.adapterHost, this.gate);
  }
}
