import { Inject, Injectable } from '@nestjs/common';
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
import { generateNonce, generateOtpCode, hashOtpCode, otpCodeMatches } from './otp-code';
import { WebSessionService, type SessionLogin, type SessionMeta } from './web-session.service';

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

  constructor(
    private readonly requests: LoginRequestRepository,
    private readonly sessions: WebSessionService,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'OTP_PEPPER' | 'TELEGRAM_BOT_USERNAME'>,
  ) {
    this.pepper = config.OTP_PEPPER;
    this.botUsername = config.TELEGRAM_BOT_USERNAME;
  }

  /** Web: opens a login request that waits LOGIN_NONCE_TTL_SEC for the user to open the bot. */
  async start(now: Date): Promise<LoginStartResponse> {
    const nonce = generateNonce();
    await this.requests.create(nonce, new Date(now.getTime() + LOGIN_NONCE_TTL_SEC * MS));
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
   * FOR THE BOT (slice S7b). Hands out the login code for `nonce` to the Telegram account that
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
   * FOR THE BOT ("this was not me"). CODE_SENT -> DENIED, only for the account that holds the
   * code. Idempotent: true when the request is DENIED by this account afterwards (this call or an
   * earlier one), false when it is not theirs to deny (unknown, other account, wrong state).
   */
  async deny(input: DenyInput): Promise<boolean> {
    if (await this.requests.deny(input.nonce, input.telegramId, input.now)) return true;
    const row = await this.requests.findByNonce(input.nonce);
    return row?.status === 'DENIED' && row.telegramId === input.telegramId;
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
    return this.requests.transaction(async (tx) => {
      // The guarded UPDATE is the gate: of several parallel correct codes exactly one gets here.
      if (!(await this.requests.markUsed(attempt.id, now, tx))) throw new AppError('CODE_EXPIRED');
      const session = await this.sessions.createSession(user.id, meta, now, tx);
      return {
        user: toMe(user),
        refreshToken: session.refreshToken,
        accessToken: this.sessions.issueAccessToken(user.id, session.familyId, now),
      };
    });
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
