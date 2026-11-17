import { Inject, Injectable, Logger } from '@nestjs/common';
import { adminSessionCookieName } from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { cookieValues } from '../../auth/cookie-header';
import { AdminSessionService } from '../auth/admin-session.service';
import { adminRequestAllowed } from './admin-csrf.guard';
import { isWriteMethod, type AdminPrincipal, type AdminRequest } from './admin-request';
import { AdminThrottle } from './admin-throttle';

/**
 * The session and refusal half of the admin guards, shared by AdminGuard and the admin not-found
 * hook (admin-not-found.hook.ts), so a request that reaches an admin handler and one that the
 * router sends to its not-found handler are checked, counted and answered alike.
 */
@Injectable()
export class AdminRequestGate {
  private readonly cookieName: string;
  private readonly logger = new Logger('Security');

  constructor(
    private readonly sessions: AdminSessionService,
    private readonly throttle: AdminThrottle,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'NODE_ENV' | 'ADMIN_URL'>,
  ) {
    this.cookieName = adminSessionCookieName(config.NODE_ENV);
  }

  /**
   * The live session behind exactly one admin cookie (not revoked, under 8 h, used within 1 h,
   * admin active and allowlisted), or null for every refusal alike. A user cookie or a Bearer
   * token is never read here.
   */
  async principal(request: AdminRequest): Promise<AdminPrincipal | null> {
    const token = this.readToken(request);
    return token === null ? null : this.sessions.authenticate(token, this.clock.now());
  }

  /**
   * An admin-prefixed request that no admin handler will run for (S2R-1): what AdminCsrfGuard and
   * AdminGuard do with a route nobody may call. A wrong shape or no session counts against the
   * anonymous per-IP budget; a live session against its own budgets. Then the one 404, or the
   * same 429 once a budget is used up.
   */
  async refuseUnrouted(request: AdminRequest): Promise<never> {
    if (!adminRequestAllowed(request, this.config.ADMIN_URL)) {
      return this.throttle.refuseAnonymous(request.ip);
    }
    const principal = await this.principal(request);
    if (principal === null) return this.throttle.refuseAnonymous(request.ip);
    await this.throttle.countSession(principal.sessionId, isWriteMethod(request.method));
    throw new AppError('NOT_FOUND');
  }

  private readToken(request: AdminRequest): string | null {
    // A repeated name cannot be attributed to the caller (a planted twin cookie): no session.
    if (cookieValues(request.headers['cookie'], this.cookieName).length > 1) {
      this.logger.warn('security event=DUPLICATE_AUTH_COOKIE cookie=admin endpoint=guard');
      return null;
    }
    const value = request.cookies?.[this.cookieName];
    return typeof value === 'string' && value !== '' ? value : null;
  }
}
