import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminSession, AdminUser } from '@repo/db';
import { ADMIN_SESSION_IDLE_SEC, ADMIN_SESSION_TTL_SEC } from '@repo/shared';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import type { Db } from '../../../infra/prisma/db';
import { maskIp } from '../../auth/mask-ip';
import { mayUsePanel } from '../admins/admin-allowlist';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import type { AdminPrincipal } from '../common/admin-request';
import { AdminSessionRepository } from './admin-session.repository';

const MS = 1000;
/** `lastUsedAt` is written at most once per this many ms per session. */
export const ADMIN_TOUCH_EVERY_MS = 60_000;
// Tokens we issue are exactly 43 base64url characters (256 bits); anything else is not ours and
// never reaches the database.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The cookie value: 256 random bits. */
export function newAdminToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps instead of the token (docs/04 «Sessiya»): sha256, hex. */
export function hashAdminToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Not revoked, under its absolute life, and used within the idle limit. */
export function isSessionLive(
  row: Pick<AdminSession, 'revokedAt' | 'expiresAt' | 'lastUsedAt'>,
  now: Date,
): boolean {
  if (row.revokedAt !== null) return false;
  if (row.expiresAt.getTime() <= now.getTime()) return false;
  return row.lastUsedAt.getTime() + ADMIN_SESSION_IDLE_SEC * MS > now.getTime();
}

function idleExpiry(expiresAt: Date, lastUsedAt: Date): Date {
  const idle = lastUsedAt.getTime() + ADMIN_SESSION_IDLE_SEC * MS;
  return new Date(Math.min(expiresAt.getTime(), idle));
}

export interface OpenedSession {
  readonly sessionId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** How the bot's "this was not me" under a new-login message ended. */
export type BotSessionEnd = 'ended' | 'alreadyEnded';

@Injectable()
export class AdminSessionService {
  private readonly logger = new Logger('Security');

  constructor(
    private readonly repo: AdminSessionRepository,
    private readonly admins: AdminUsersRepository,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
  ) {}

  /**
   * For AdminGuard, on every request. null for every refusal alike (unknown token, revoked,
   * expired, idle, inactive admin, Telegram id no longer allowlisted): the caller answers 404.
   * The admin row comes with the session from the same read, so role and isActive are current.
   */
  async authenticate(token: string, now: Date): Promise<AdminPrincipal | null> {
    if (!TOKEN_SHAPE.test(token)) return null;
    const row = await this.repo.findByTokenHash(hashAdminToken(token));
    if (row === null || !isSessionLive(row, now)) return null;
    if (!mayUsePanel(this.config, row.admin)) return null;

    let lastUsedAt = row.lastUsedAt;
    const staleBefore = new Date(now.getTime() - ADMIN_TOUCH_EVERY_MS);
    if (lastUsedAt.getTime() < staleBefore.getTime()) {
      await this.repo.touch(row.id, now, staleBefore);
      lastUsedAt = now;
    }
    return {
      sessionId: row.id,
      admin: row.admin,
      expiresAt: row.expiresAt,
      idleExpiresAt: idleExpiry(row.expiresAt, lastUsedAt),
    };
  }

  /** A new session inside the caller's (login) transaction; only the token's hash is stored. */
  async open(tx: Db, admin: AdminUser, ip: string | null, now: Date): Promise<OpenedSession> {
    const token = newAdminToken();
    const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_SEC * MS);
    // After the caller's FOR SHARE on the admin row (lockForLogin): a panel revoke of this admin
    // waits for this commit and then ends the session opened here too (CR-2 / SA L-1).
    await this.repo.lockAdminSessions(tx, admin.id);
    const sessionId = await this.repo.create(tx, {
      adminId: admin.id,
      tokenHash: hashAdminToken(token),
      ipMasked: maskIp(ip),
      now,
      expiresAt,
    });
    return { sessionId, token, expiresAt };
  }

  /** Ends the caller's session and audits it (ADMIN_LOGOUT), in one transaction. */
  async logout(principal: AdminPrincipal, ip: string | null, now: Date): Promise<void> {
    await this.admins.transaction(async (tx) => {
      // Already ended by a parallel logout or a revoke: nothing to audit twice.
      if (!(await this.repo.revoke(tx, principal.sessionId, now))) return;
      await this.admins.createAudit(tx, {
        actorType: 'ADMIN',
        actorId: principal.admin.id,
        action: 'ADMIN_LOGOUT',
        targetType: 'AdminSession',
        targetId: principal.sessionId,
        before: null,
        after: { revokedSessions: 1 },
        reason: null,
        ip,
      });
    });
  }

  /**
   * FOR THE BOT: "this was not me" under the new-login message. Acts only for the Telegram
   * account the session belongs to; anything else (unknown id, another account) is
   * `alreadyEnded`, which tells a prober nothing. Audited as ADMIN_SESSION_REVOKE by that admin.
   */
  async endFromBot(sessionId: string, telegramId: bigint, now: Date): Promise<BotSessionEnd> {
    const session = await this.repo.findById(sessionId);
    if (session?.admin.telegramId !== telegramId) return 'alreadyEnded';
    return this.endInTransaction(session.id, session.adminId, now, 'bot');
  }

  /** Ends a session the deny of its login request points at (same account checked by the caller). */
  async endForDeniedLogin(sessionId: string, telegramId: bigint, now: Date, tx: Db) {
    const session = await this.repo.findById(sessionId, tx);
    if (session?.admin.telegramId !== telegramId) return false;
    return this.revokeAndAudit(tx, session.id, session.adminId, now, 'botDeny');
  }

  private endInTransaction(
    sessionId: string,
    adminId: string,
    now: Date,
    source: string,
  ): Promise<BotSessionEnd> {
    return this.admins.transaction(async (tx) =>
      (await this.revokeAndAudit(tx, sessionId, adminId, now, source)) ? 'ended' : 'alreadyEnded',
    );
  }

  private async revokeAndAudit(
    tx: Db,
    sessionId: string,
    adminId: string,
    now: Date,
    source: string,
  ): Promise<boolean> {
    if (!(await this.repo.revoke(tx, sessionId, now))) return false;
    await this.admins.createAudit(tx, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'ADMIN_SESSION_REVOKE',
      targetType: 'AdminSession',
      targetId: sessionId,
      before: null,
      after: { revokedSessions: 1, source },
      reason: null,
      ip: null,
    });
    this.logger.warn(`security event=ADMIN_SESSION_ENDED source=${source} sessionId=${sessionId}`);
    return true;
  }
}
