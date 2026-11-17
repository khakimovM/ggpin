import { Injectable, Logger } from '@nestjs/common';
import { normalizeIp } from '@nestjs/throttler';
import { AppError } from '../../../common/exceptions/app-error';
import { IPV6_CLIENT_PREFIX } from '../../../common/http/http-pipeline.module';
import { FixedWindowCounter, type WindowHit } from '../../../infra/redis/fixed-window-counter';

export interface AdminLimit {
  readonly max: number;
  readonly windowSec: number;
}

/** Requests to admin routes without a usable session, per client IP (IPv6 /64; SA-L6). */
export const ADMIN_ANONYMOUS_LIMIT: AdminLimit = { max: 60, windowSec: 60 };
/** Every request of one admin session. */
export const ADMIN_SESSION_LIMIT: AdminLimit = { max: 120, windowSec: 60 };
/** State-changing requests (POST/PATCH) of one admin session, on top of the limit above. */
export const ADMIN_WRITE_LIMIT: AdminLimit = { max: 30, windowSec: 60 };

export const adminAnonymousLimitKey = (ip: string): string =>
  `rl:adm:ip:${normalizeIp(ip, IPV6_CLIENT_PREFIX)}`;
export const adminSessionLimitKey = (sessionId: string): string => `rl:adm:s:${sessionId}`;
export const adminWriteLimitKey = (sessionId: string): string => `rl:adm:w:${sessionId}`;
/** One window per masked Telegram id for the ADMIN_CODE_REFUSED warn line (S2-m3). */
export const adminCodeRefusedLogKey = (maskedTelegramId: string): string =>
  `adm:log:code-refused:${maskedTelegramId}`;

/**
 * The admin surface's own rate limits (docs/04 «Admin», «Limitlar»), counted in Redis so every
 * API process shares them. The login routes are not counted here: they carry their own per-IP
 * @Throttle budgets.
 *
 * Redis down: an anonymous request is still refused (404, nothing else to decide), and a signed-in
 * admin is let through with a warning: the limits are flood control, not access control, and the
 * panel must stay usable while an incident is being handled.
 */
@Injectable()
export class AdminThrottle {
  private readonly logger = new Logger('Security');

  constructor(private readonly counter: FixedWindowCounter) {}

  /**
   * Every refusal of a session route ends here: counts the IP, then throws. Over the limit the
   * answer is 429 + Retry-After (the same shape a session-less request gets anywhere), otherwise
   * the one 404 of every other refusal (D-26).
   */
  async refuseAnonymous(ip: string): Promise<never> {
    const hit = await this.safeHit(adminAnonymousLimitKey(ip), ADMIN_ANONYMOUS_LIMIT);
    if (hit !== null && hit.count > ADMIN_ANONYMOUS_LIMIT.max) {
      if (hit.count === ADMIN_ANONYMOUS_LIMIT.max + 1) {
        this.logger.warn('security event=ADMIN_RATE_LIMITED scope=anonymous');
      }
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: hit.ttlSec });
    }
    throw new AppError('NOT_FOUND');
  }

  /** Counts one request of a live session; throws 429 when a budget is used up. */
  async countSession(sessionId: string, write: boolean): Promise<void> {
    await this.enforce(adminSessionLimitKey(sessionId), ADMIN_SESSION_LIMIT, sessionId, 'session');
    if (write)
      await this.enforce(adminWriteLimitKey(sessionId), ADMIN_WRITE_LIMIT, sessionId, 'write');
  }

  /**
   * True for the first call with `key` in a `windowSec` window (Redis, shared by every API
   * process), false for the rest. For log lines that outsiders can trigger at will: one warn per
   * window is the alert signal (K3), the rest go to debug. Redis down: true, so a security line
   * is never silenced by an outage (S2R-4); without the counter there is no flood control anyway.
   */
  async firstInWindow(key: string, windowSec: number): Promise<boolean> {
    try {
      return (await this.counter.hit(key, windowSec)).count === 1;
    } catch {
      return true;
    }
  }

  private async enforce(key: string, limit: AdminLimit, sessionId: string, scope: string) {
    const hit = await this.safeHit(key, limit);
    if (hit === null || hit.count <= limit.max) return;
    // Once per window: the line is an alert signal (K3), not a per-request log.
    if (hit.count === limit.max + 1) {
      this.logger.warn(`security event=ADMIN_RATE_LIMITED scope=${scope} sessionId=${sessionId}`);
    }
    throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: hit.ttlSec });
  }

  private async safeHit(key: string, limit: AdminLimit): Promise<WindowHit | null> {
    try {
      return await this.counter.hit(key, limit.windowSec);
    } catch (error) {
      // Name only: a Redis error message can quote the connection URL.
      this.logger.warn(
        `admin rate limit not counted: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return null;
    }
  }
}
