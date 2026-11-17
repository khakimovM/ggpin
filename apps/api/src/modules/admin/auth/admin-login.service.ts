import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminUser } from '@repo/db';
import {
  BOT_CODE_ISSUE_LIMIT,
  LOGIN_NONCE_PATTERN,
  LOGIN_NONCE_TTL_SEC,
  OTP_CODE_TTL_SEC,
  OTP_MAX_ATTEMPTS,
  type AdminLoginStartResponse,
  type AdminLoginStatusResponse,
} from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { deviceLabel } from '../../auth/device-label';
import { maskIp } from '../../auth/mask-ip';
import {
  publicLoginStatus,
  unclaimableReason,
  type IssueCodeFailure,
} from '../../auth/login-claim';
import { generateNonce, generateOtpCode, hashOtpCode, otpCodeMatches } from '../../auth/otp-code';
import type {
  DenyResult,
  DenyInput,
  IssueCodeInput,
  ReleaseCodeInput,
} from '../../auth/otp-login.service';
import { maskTelegramId, mayUsePanel } from '../admins/admin-allowlist';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import { AdminThrottle, adminCodeRefusedLogKey } from '../common/admin-throttle';
import { AdminLoginNoticeService } from './admin-login-notice.service';
import { AdminLoginOriginStore, type AdminLoginOrigin } from './admin-login-origin.store';
import { AdminLoginRequestRepository } from './admin-login-request.repository';
import { AdminSessionService } from './admin-session.service';

export type AdminIssueCodeResult =
  | { readonly ok: true; readonly code: string; readonly origin: AdminLoginOrigin | null }
  | { readonly ok: false; readonly reason: IssueCodeFailure };

/** The client of an admin login call; the raw address is only kept in the AuditLog row. */
export interface AdminClient {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AdminVerifyInput extends AdminClient {
  readonly nonce: string;
  readonly code: string;
  readonly now: Date;
}

export interface AdminLogin {
  readonly admin: AdminUser;
  readonly token: string;
}

const MS = 1000;

// The admin panel's login through the bot (docs/04 «Auth», D-27 pattern, D-63 (9)): the web
// login's rules (LoginRequest kind ADMIN, 43-char nonce for 10 minutes, a 6-digit code for 3
// minutes, 5 attempts, one use, 5 codes per account per 10 minutes) with two more keys: the code
// goes only to an active AdminUser whose Telegram id is in ADMIN_TELEGRAM_IDS, checked again when
// the code is exchanged for a session.
@Injectable()
export class AdminLoginService {
  private readonly pepper: string;
  private readonly botUsername: string;
  private readonly logger = new Logger('Security');

  constructor(
    private readonly requests: AdminLoginRequestRepository,
    private readonly admins: AdminUsersRepository,
    private readonly sessions: AdminSessionService,
    private readonly origins: AdminLoginOriginStore,
    private readonly notice: AdminLoginNoticeService,
    private readonly throttle: AdminThrottle,
    @Inject(APP_CONFIG)
    private readonly config: Pick<
      AppConfig,
      'OTP_PEPPER' | 'TELEGRAM_BOT_USERNAME' | 'ADMIN_TELEGRAM_IDS'
    >,
  ) {
    this.pepper = config.OTP_PEPPER;
    this.botUsername = config.TELEGRAM_BOT_USERNAME;
  }

  async start(now: Date, client: AdminClient): Promise<AdminLoginStartResponse> {
    const nonce = generateNonce();
    await this.requests.create({
      nonce,
      now,
      expiresAt: new Date(now.getTime() + LOGIN_NONCE_TTL_SEC * MS),
    });
    await this.origins.remember(nonce, client.ip, client.userAgent);
    return { nonce, botUrl: `https://t.me/${this.botUsername}?start=admin_${nonce}` };
  }

  /** Read-only polling, the web login's answers; an unknown or non-admin nonce is a 404. */
  async status(nonce: string, now: Date): Promise<AdminLoginStatusResponse> {
    const row = await this.requests.findByNonce(nonce);
    if (row === null || row.kind !== 'ADMIN') throw new AppError('NOT_FOUND');
    return { status: publicLoginStatus(row, now) };
  }

  /**
   * FOR THE BOT. The code for `nonce`, only to an account that may use the panel. Anyone else gets
   * `expired` and nothing is written (the request stays PENDING: the page learns nothing, no
   * oracle). The plain code is only in the returned value (never stored, logged or queued).
   */
  async issueCode(input: IssueCodeInput): Promise<AdminIssueCodeResult> {
    const { nonce, telegramId, now } = input;
    if (!LOGIN_NONCE_PATTERN.test(nonce)) return { ok: false, reason: 'expired' };
    if (!mayUsePanel(this.config, await this.admins.findByTelegramId(telegramId))) {
      await this.logRefusal(maskTelegramId(telegramId));
      return { ok: false, reason: 'expired' };
    }

    const code = generateOtpCode();
    const codeHash = hashOtpCode(this.pepper, nonce, code);
    const codeExpiresAt = new Date(now.getTime() + OTP_CODE_TTL_SEC * MS);
    const windowStart = new Date(now.getTime() - BOT_CODE_ISSUE_LIMIT.windowSec * MS);
    const result = await this.requests.transaction(async (tx) => {
      await this.requests.lockTelegramId(telegramId, tx);
      const row = await this.requests.findByNonce(nonce, tx);
      const blocked = unclaimableReason(row, 'ADMIN', telegramId, now);
      if (blocked !== null) return blocked;
      const issued = await this.requests.countCodesIssuedSince(telegramId, windowStart, tx);
      if (issued >= BOT_CODE_ISSUE_LIMIT.max) return 'rateLimited';
      const claim = { nonce, telegramId, codeHash, codeExpiresAt, now };
      if (await this.requests.claimForCode(claim, tx)) return null;
      const after = await this.requests.findByNonce(nonce, tx);
      return unclaimableReason(after, 'ADMIN', telegramId, now) ?? 'expired';
    });
    if (result === 'rateLimited') {
      // K3: the bot's code quota of a real admin ran out; an alert signal, not routine noise.
      this.logger.warn(
        `security event=ADMIN_CODE_QUOTA_EXHAUSTED telegramId=${maskTelegramId(telegramId)}`,
      );
    }
    if (result !== null) return { ok: false, reason: result };
    return { ok: true, code, origin: await this.origins.read(nonce) };
  }

  /** FOR THE BOT: the code message could not be sent; the link may be opened again. */
  async releaseCode(input: ReleaseCodeInput): Promise<boolean> {
    const { nonce, telegramId, code, now } = input;
    if (!LOGIN_NONCE_PATTERN.test(nonce)) return false;
    const codeHash = hashOtpCode(this.pepper, nonce, code);
    return this.requests.release({ nonce, telegramId, codeHash, now });
  }

  /**
   * FOR THE BOT ("this was not me" under the code message). A live code of this account becomes
   * DENIED; a code that already opened a session gets that session ended (and audited) in the same
   * transaction; anything else is `expired`. Idempotent like the web login's deny.
   */
  async deny(input: DenyInput): Promise<DenyResult> {
    const { nonce, telegramId, now } = input;
    const deniedId = await this.requests.deny(nonce, telegramId, now);
    if (deniedId !== null) {
      this.logger.warn(`security event=ADMIN_LOGIN_DENIED loginRequestId=${deniedId}`);
      return 'denied';
    }
    const row = await this.requests.findByNonce(nonce);
    if (row === null || row.kind !== 'ADMIN' || row.telegramId !== telegramId) return 'expired';
    const sessionId = row.sessionFamilyId; // for ADMIN rows: the AdminSession it opened
    if (sessionId === null) return row.status === 'DENIED' ? 'denied' : 'expired';
    if (row.status !== 'USED' && row.status !== 'DENIED') return 'expired';
    await this.requests.transaction(async (tx) => {
      await this.requests.denyUsed(nonce, telegramId, tx);
      await this.sessions.endForDeniedLogin(sessionId, telegramId, now, tx);
    });
    return 'sessionEnded';
  }

  /**
   * Checks the code and, when right, opens a session. Every failure that is not "wrong code" is
   * the same CODE_EXPIRED (unknown, used, denied, expired, admin deactivated or no longer
   * allowlisted since the code was sent), so a probe cannot tell them apart.
   */
  async verify(input: AdminVerifyInput): Promise<AdminLogin> {
    const { nonce, code, now } = input;
    // Counted and committed BEFORE the comparison (and outside the transaction below), so a
    // guess stays counted whatever fails later.
    const attempt = await this.requests.registerAttempt(nonce, now);
    if (attempt === null || attempt.codeHash === null || attempt.telegramId === null) {
      throw new AppError('CODE_EXPIRED');
    }
    if (!otpCodeMatches(this.pepper, nonce, code, attempt.codeHash)) {
      if (attempt.attempts >= OTP_MAX_ATTEMPTS) {
        this.logger.warn(
          `security event=ADMIN_OTP_ATTEMPTS_EXHAUSTED loginRequestId=${attempt.id}`,
        );
      }
      throw new AppError('CODE_INVALID', {
        attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempt.attempts),
      });
    }
    // A cheap early answer; the decision itself is taken again under the row lock below.
    const found = await this.admins.findByTelegramId(attempt.telegramId);
    if (!mayUsePanel(this.config, found)) throw new AppError('CODE_EXPIRED');

    const { session: opened, admin } = await this.requests.transaction(async (tx) => {
      // S2R-2: the AdminUser row again, under FOR SHARE. A deactivation (or role change) that
      // committed after the read above is seen here; one still running makes us wait for it; one
      // that starts later waits for this commit and then ends the session opened here.
      const locked = await this.admins.lockForLogin(tx, found.id);
      if (!mayUsePanel(this.config, locked)) throw new AppError('CODE_EXPIRED');
      // The guarded UPDATE is the gate: of several parallel correct codes exactly one gets here.
      if (!(await this.requests.markUsed(attempt.id, now, tx))) throw new AppError('CODE_EXPIRED');
      const session = await this.sessions.open(tx, locked, input.ip, now);
      if (!(await this.requests.linkSession(attempt.id, session.sessionId, tx))) {
        throw new Error('admin login request lost its USED state inside the verify transaction');
      }
      await this.admins.createAudit(tx, {
        actorType: 'ADMIN',
        actorId: locked.id,
        action: 'ADMIN_LOGIN',
        targetType: 'AdminSession',
        targetId: session.sessionId,
        before: null,
        after: {
          role: locked.role,
          device: deviceLabel(input.userAgent),
          ipMasked: maskIp(input.ip),
          expiresAt: session.expiresAt.toISOString(),
        },
        reason: null,
        ip: input.ip,
      });
      return { session, admin: locked };
    });
    this.logger.log(`security event=ADMIN_LOGIN adminId=${admin.id} sessionId=${opened.sessionId}`);
    // After the commit and never fatal: the login already succeeded.
    await this.notice.loggedIn({
      admin,
      sessionId: opened.sessionId,
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
    return { admin, token: opened.token };
  }

  // Anyone can send /start admin_<x> to the bot, so a warn per message would let an outsider
  // flood the log (S2-m3): one warn per masked id and code window, the rest at debug.
  private async logRefusal(maskedTelegramId: string): Promise<void> {
    const line = `security event=ADMIN_CODE_REFUSED telegramId=${maskedTelegramId}`;
    const key = adminCodeRefusedLogKey(maskedTelegramId);
    if (await this.throttle.firstInWindow(key, BOT_CODE_ISSUE_LIMIT.windowSec)) {
      this.logger.warn(line);
    } else {
      this.logger.debug(line);
    }
  }
}
