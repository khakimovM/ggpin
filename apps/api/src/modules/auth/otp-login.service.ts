import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LoginRequest } from '@repo/db';
import {
  BOT_CODE_ISSUE_LIMIT,
  LOGIN_NONCE_PATTERN,
  LOGIN_NONCE_TTL_SEC,
  OTP_CODE_TTL_SEC,
  OTP_MAX_ATTEMPTS,
  type LoginStartResponse,
  type LoginStatusResponse,
} from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { toMe } from '../users/entities/me.mapper';
import { UsersService } from '../users/users.service';
import { LoginRequestRepository } from './login-request.repository';
import { NewLoginNoticeService } from './new-login-notice.service';
import { generateNonce, generateOtpCode, hashOtpCode, otpCodeMatches } from './otp-code';
import { WebSessionService, type SessionLogin, type SessionMeta } from './web-session.service';

/**
 * Outcome of the "this was not me" button: `denied` (the code was cancelled before use),
 * `sessionEnded` (the code had already opened a session and that session was ended) or
 * `expired` (nothing of this account's to cancel).
 */
export type DenyResult = 'denied' | 'sessionEnded' | 'expired';

/** Why the bot may not hand out a code for a login link. */
export type IssueCodeFailure = 'expired' | 'alreadySent' | 'usedByOther' | 'rateLimited';

export type IssueCodeResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: IssueCodeFailure };

export interface IssueCodeInput {
  readonly nonce: string;
  readonly telegramId: bigint;
  readonly now: Date;
}

export interface DenyInput {
  readonly nonce: string;
  readonly telegramId: bigint;
  readonly now: Date;
}

export interface ReleaseCodeInput {
  readonly nonce: string;
  readonly telegramId: bigint;
  /** The plain code that could not be delivered; only its HMAC is compared. */
  readonly code: string;
  readonly now: Date;
}

export interface VerifyInput {
  readonly nonce: string;
  readonly code: string;
  readonly now: Date;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

const MS = 1000;

@Injectable()
export class OtpLoginService {
  private readonly pepper: string;
  private readonly botUsername: string;
  private readonly logger = new Logger('Security');

  constructor(
    private readonly requests: LoginRequestRepository,
    private readonly sessions: WebSessionService,
    private readonly users: UsersService,
    private readonly notice: NewLoginNoticeService,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'OTP_PEPPER' | 'TELEGRAM_BOT_USERNAME'>,
  ) {
    this.pepper = config.OTP_PEPPER;
    this.botUsername = config.TELEGRAM_BOT_USERNAME;
  }

  /** Web: opens a login request that waits LOGIN_NONCE_TTL_SEC for the user to open the bot. */
  async start(now: Date): Promise<LoginStartResponse> {
    const nonce = generateNonce();
    await this.requests.create({
      nonce,
      now,
      expiresAt: new Date(now.getTime() + LOGIN_NONCE_TTL_SEC * MS),
    });
    return { nonce, botUrl: `https://t.me/${this.botUsername}?start=login_${nonce}` };
  }

  /**
   * Web polling. Read-only: a request that ran out of time is reported as EXPIRED without being
   * written. USED is reported as EXPIRED too, so a consumed nonce reveals nothing. An unknown
   * nonce (or one that is not a user login) is a 404.
   */
  async status(nonce: string, now: Date): Promise<LoginStatusResponse> {
    const row = await this.requests.findByNonce(nonce);
    if (row === null || row.kind !== 'USER') throw new AppError('NOT_FOUND');
    if (row.status === 'DENIED') return { status: 'DENIED' };
    if (row.status === 'PENDING' && !isLive(row, now)) return { status: 'EXPIRED' };
    if (row.status === 'PENDING') return { status: 'PENDING' };
    if (row.status === 'CODE_SENT' && isLive(row, now) && row.attempts < OTP_MAX_ATTEMPTS) {
      return { status: 'CODE_SENT' };
    }
    return { status: 'EXPIRED' };
  }

  /**
   * FOR THE BOT. Hands out the login code for `nonce` to the Telegram account that
   * opened the link. The plain code is only ever in the returned value: it is not stored (only
   * its HMAC), not logged and must not be put in a queue job, so the bot has to send it from
   * inside the update handler.
   *
   * Outcomes: `expired` (unknown, used, denied, out of attempts or out of time), `alreadySent`
   * (this account already holds a live code: a duplicate webhook delivery gets no second code),
   * `usedByOther` (another account holds the request) and `rateLimited` (BOT_CODE_ISSUE_LIMIT
   * codes already sent to this account in the window, counted in Postgres).
   */
  async issueCode(input: IssueCodeInput): Promise<IssueCodeResult> {
    const { nonce, telegramId, now } = input;
    if (!LOGIN_NONCE_PATTERN.test(nonce)) return { ok: false, reason: 'expired' };

    const code = generateOtpCode();
    const codeHash = hashOtpCode(this.pepper, nonce, code);
    const codeExpiresAt = new Date(now.getTime() + OTP_CODE_TTL_SEC * MS);
    const windowStart = new Date(now.getTime() - BOT_CODE_ISSUE_LIMIT.windowSec * MS);

    return this.requests.transaction(async (tx): Promise<IssueCodeResult> => {
      // One issuer per account at a time, so counting and claiming cannot be raced past the limit.
      await this.requests.lockTelegramId(telegramId, tx);
      const blocked = unclaimableReason(
        await this.requests.findByNonce(nonce, tx),
        telegramId,
        now,
      );
      if (blocked !== null) return { ok: false, reason: blocked };

      const issued = await this.requests.countCodesIssuedSince(telegramId, windowStart, tx);
      if (issued >= BOT_CODE_ISSUE_LIMIT.max) return { ok: false, reason: 'rateLimited' };

      const claimed = await this.requests.claimForCode(
        { nonce, telegramId, codeHash, codeExpiresAt, now },
        tx,
      );
      if (claimed) return { ok: true, code };
      // Lost the claim to another account between the read and the write.
      const after = unclaimableReason(await this.requests.findByNonce(nonce, tx), telegramId, now);
      return { ok: false, reason: after ?? 'expired' };
    });
  }

  /**
   * FOR THE BOT ("this was not me"). Idempotent, and only ever acts for the account the request
   * belongs to:
   * - a live CODE_SENT held by this account becomes DENIED (`denied`);
   * - a USED request of this account (the code was already exchanged for a session) is DENIED
   *   and that session's family is revoked in the same transaction (`sessionEnded`), with no
   *   time limit;
   * - a replay of either returns the same answer;
   * - anything else (unknown, another account, PENDING, expired) is `expired`.
   * A deny racing a verify ends consistently: the guarded UPDATEs serialise on the row, so
   * either the code dies before it opens a session or the session it opened is ended.
   */
  async deny(input: DenyInput): Promise<DenyResult> {
    const { nonce, telegramId, now } = input;
    const deniedId = await this.requests.deny(nonce, telegramId, now);
    if (deniedId !== null) {
      this.logger.warn(`security event=LOGIN_DENIED loginRequestId=${deniedId}`);
      return 'denied';
    }
    const row = await this.requests.findByNonce(nonce);
    if (row === null || row.kind !== 'USER' || row.telegramId !== telegramId) return 'expired';
    if (row.sessionFamilyId === null) return row.status === 'DENIED' ? 'denied' : 'expired';
    // USED, or DENIED after the code opened a session (a replay): end that session. Idempotent
    // and cheap, and it repairs a first attempt that was cut short.
    if (row.status === 'USED' || row.status === 'DENIED') {
      return this.endUsedLogin(row.id, nonce, telegramId, row.sessionFamilyId, now);
    }
    return 'expired';
  }

  // Lock order: the LoginRequest row (denyUsed's UPDATE) first, then the session-family lock
  // (revokeFamilyIn). The family lock is also taken alone by refresh and by every revoke, but
  // nothing holds it and then asks for a LoginRequest row, so the two cannot deadlock.
  private async endUsedLogin(
    id: string,
    nonce: string,
    telegramId: bigint,
    familyId: string,
    now: Date,
  ): Promise<DenyResult> {
    // Looked up before the transaction (one pooled connection at a time).
    const user = await this.users.findByTelegramId(telegramId);
    if (user === null) return 'expired';
    const revoked = await this.requests.transaction(async (tx) => {
      // Already DENIED (a replay, or a parallel deny that committed first): nothing to flip, but
      // the revoke below still runs, so the session is ended whichever call gets here.
      await this.requests.denyUsed(nonce, telegramId, tx);
      return this.sessions.revokeFamilyIn({ userId: user.id, familyId, now }, tx);
    });
    if (revoked > 0) {
      this.logger.warn(
        `security event=LOGIN_SESSION_ENDED userId=${user.id} familyId=${familyId} loginRequestId=${id}`,
      );
    }
    // Ended just now, or none was live any more (already ended): the user's answer is the same.
    return 'sessionEnded';
  }

  /**
   * FOR THE BOT. The code message could not be sent, so the code is worthless to the user:
   * put the request back to PENDING (same nonce, its own original lifetime) so the link can be
   * opened again. True only when this account still held exactly this untried code.
   */
  async releaseCode(input: ReleaseCodeInput): Promise<boolean> {
    const { nonce, telegramId, code, now } = input;
    if (!LOGIN_NONCE_PATTERN.test(nonce)) return false;
    const codeHash = hashOtpCode(this.pepper, nonce, code);
    return this.requests.release({ nonce, telegramId, codeHash, now });
  }

  /**
   * Web: checks the code and, when right, opens a session. Every failure that is not "wrong
   * code" is the same CODE_EXPIRED, so a probe cannot tell unknown from used from denied.
   */
  async verify(input: VerifyInput): Promise<SessionLogin> {
    const { nonce, code, now } = input;

    // Counted in its own, already committed step and NOT in the transaction below: an attempt
    // must stay counted when anything later fails or rolls back, otherwise a caller could
    // retry a guess for free by provoking a failure after the comparison.
    const attempt = await this.requests.registerAttempt(nonce, now);
    if (attempt === null || attempt.codeHash === null || attempt.telegramId === null) {
      throw new AppError('CODE_EXPIRED');
    }
    if (!otpCodeMatches(this.pepper, nonce, code, attempt.codeHash)) {
      if (attempt.attempts >= OTP_MAX_ATTEMPTS) {
        this.logger.warn(`security event=OTP_ATTEMPTS_EXHAUSTED loginRequestId=${attempt.id}`);
      }
      throw new AppError('CODE_INVALID', {
        attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempt.attempts),
      });
    }

    // Looked up before the transaction: inside it we would hold one pooled connection and ask
    // for a second, which can starve the pool under load.
    const user = await this.users.findByTelegramId(attempt.telegramId);
    if (user === null) throw new AppError('CODE_EXPIRED');
    if (user.isBlocked) throw new AppError('USER_BLOCKED');

    const meta: SessionMeta = { userAgent: input.userAgent, ip: input.ip };
    const { login, familyId } = await this.requests.transaction(async (tx) => {
      // The guarded UPDATE is the gate: of several parallel correct codes exactly one gets here.
      if (!(await this.requests.markUsed(attempt.id, now, tx))) throw new AppError('CODE_EXPIRED');
      const session = await this.sessions.createSession(user.id, meta, now, tx);
      // Same transaction: a USED request without its session would make "this was not me" a no-op.
      if (!(await this.requests.linkSession(attempt.id, session.familyId, tx))) {
        throw new Error('login request lost its USED state inside the verify transaction');
      }
      return {
        familyId: session.familyId,
        login: {
          user: toMe(user),
          refreshToken: session.refreshToken,
          accessToken: this.sessions.issueAccessToken(user.id, session.familyId, now),
        },
      };
    });
    // After the commit and never fatal: the login already succeeded.
    await this.notice.send({ user, familyId, meta, now });
    return login;
  }
}

function isLive(row: LoginRequest, now: Date): boolean {
  return row.expiresAt.getTime() > now.getTime();
}

// Why a login request cannot be given to `telegramId` right now; null = it can be claimed.
function unclaimableReason(
  row: LoginRequest | null,
  telegramId: bigint,
  now: Date,
): IssueCodeFailure | null {
  if (row === null || row.kind !== 'USER' || !isLive(row, now)) return 'expired';
  if (row.status === 'PENDING') {
    return row.telegramId === null || row.telegramId === telegramId ? null : 'usedByOther';
  }
  if (row.status === 'CODE_SENT') {
    if (row.attempts >= OTP_MAX_ATTEMPTS) return 'expired';
    return row.telegramId === telegramId ? 'alreadySent' : 'usedByOther';
  }
  return 'expired'; // USED, DENIED, EXPIRED
}
