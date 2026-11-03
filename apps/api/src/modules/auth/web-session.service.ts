import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  type Me,
  type SessionItem,
} from '@repo/shared';
import type { Db } from '../../infra/prisma/db';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { toMe } from '../users/entities/me.mapper';
import { UsersService } from '../users/users.service';
import { maskIp, truncateUserAgent } from './mask-ip';
import { TokenCodec } from './token-codec';
import { WebSessionRepository, type FamilyRef } from './web-session.repository';

export interface SessionMeta {
  readonly userAgent?: string | null;
  /** The raw client address; only its masked form is stored. */
  readonly ip?: string | null;
}

export interface CreatedSession {
  readonly refreshToken: string;
  readonly familyId: string;
}

export interface RotatedSession extends CreatedSession {
  readonly userId: string;
}

/** What the cookies are built from after a login or a refresh. */
export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface SessionLogin extends SessionTokens {
  readonly user: Me;
}

export const MAX_LISTED_SESSIONS = 100;

const MS = 1000;
// Opaque tokens we issue are exactly 43 base64url characters; anything else is not ours and
// never reaches the database.
const REFRESH_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class WebSessionService {
  private readonly refreshSecret: string;
  private readonly logger = new Logger('Security');

  constructor(
    private readonly repo: WebSessionRepository,
    private readonly users: UsersService,
    private readonly codec: TokenCodec,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'JWT_REFRESH_SECRET'>,
  ) {
    this.refreshSecret = config.JWT_REFRESH_SECRET;
  }

  /** Starts a new session family. Pass `tx` to make it part of the caller's transaction. */
  async createSession(
    userId: string,
    meta: SessionMeta,
    now: Date,
    tx?: Db,
  ): Promise<CreatedSession> {
    const familyId = randomUUID();
    const refreshToken = await this.insertRow(userId, familyId, meta, now, tx);
    return { refreshToken, familyId };
  }

  /** Short-lived cookie token; `sid` ties it to the family so revoking the family kills it. */
  issueAccessToken(userId: string, familyId: string, now: Date): string {
    const iat = Math.floor(now.getTime() / MS);
    return this.codec.sign({
      typ: 'web',
      sub: userId,
      sid: familyId,
      iat,
      exp: iat + ACCESS_TOKEN_TTL_SEC,
    });
  }

  /**
   * Swaps a live refresh token for a new one in the same family (sliding 30 days). The old row
   * is retired by one atomic UPDATE, so two parallel calls with the same token cannot both win.
   *
   * A token that is not live is either unknown (UNAUTHORIZED), expired (UNAUTHORIZED) or
   * already used/revoked, which is how a stolen-and-replayed token looks: then the WHOLE family
   * is revoked and TOKEN_REUSE_DETECTED is raised. Expired is deliberately not "reuse": a
   * legitimate user coming back after 30 idle days must not be told their session was stolen.
   * The family is still revoked then, which only tidies up (every row of it is long expired).
   */
  async rotate(refreshToken: string, meta: SessionMeta, now: Date): Promise<RotatedSession> {
    if (!REFRESH_TOKEN_SHAPE.test(refreshToken)) throw new AppError('UNAUTHORIZED');
    const hash = this.hashRefresh(refreshToken);

    // The family is read before the transaction (a token's family never changes) so the family
    // lock can be the first statement of the transaction; see WebSessionRepository.lockFamily.
    const known = await this.repo.findByHash(hash);
    if (known === null) throw new AppError('UNAUTHORIZED');

    const rotated = await this.repo.transaction(async (tx) => {
      // Same lock as every revoke of this family: a revoke can never run between our retire and
      // our insert, nor start before the insert commits and then miss the new row.
      await this.repo.lockFamily(known.familyId, tx);
      const old = await this.repo.revokeLiveByHash(hash, now, tx);
      if (old === null) return null;
      // Retire + insert commit together: a crash in between must not log the user out.
      const next = await this.insertRow(old.userId, old.familyId, meta, now, tx);
      return { refreshToken: next, familyId: old.familyId, userId: old.userId };
    });
    if (rotated !== null) return rotated;

    // Not live any more. Re-read: a revoke may have landed between the first read and now.
    const row = await this.repo.findByHash(hash);
    if (row === null) throw new AppError('UNAUTHORIZED');
    await this.repo.revokeFamily({ familyId: row.familyId, userId: row.userId, now });
    if (row.revokedAt === null) throw new AppError('UNAUTHORIZED');
    // Ids only: no token, hash or address in the line.
    this.logger.warn(
      `security event=TOKEN_REUSE_DETECTED userId=${row.userId} familyId=${row.familyId}`,
    );
    throw new AppError('TOKEN_REUSE_DETECTED');
  }

  /** Rotation + the checks only the account can answer, producing what the cookies need. */
  async refresh(refreshToken: string, meta: SessionMeta, now: Date): Promise<SessionLogin> {
    const rotated = await this.rotate(refreshToken, meta, now);
    const user = await this.users.findById(rotated.userId);
    if (user === null || user.isBlocked) {
      // A blocked account must not keep a working session just because it asked politely.
      await this.repo.revokeFamily({ familyId: rotated.familyId, userId: rotated.userId, now });
      throw new AppError(user === null ? 'UNAUTHORIZED' : 'USER_BLOCKED');
    }
    return {
      user: toMe(user),
      refreshToken: rotated.refreshToken,
      accessToken: this.issueAccessToken(rotated.userId, rotated.familyId, now),
    };
  }

  /** Ends one of the user's own sessions; anyone else's family is a 404, never a 403. */
  async revokeFamily(ref: FamilyRef & { readonly now: Date }): Promise<void> {
    if ((await this.repo.revokeFamily(ref)) === 0) throw new AppError('NOT_FOUND');
  }

  /**
   * Whether the family behind an access token's `sid` still has a live refresh row for this
   * user. The auth guard asks this on every cookie-authenticated request.
   */
  isFamilyActive(ref: FamilyRef, now: Date): Promise<boolean> {
    return this.repo.isFamilyActive(ref, now);
  }

  /**
   * FOR THE BOT ("this was not me" on the new-login notice). Ends the family only when it
   * belongs to the user that owns `telegramId`; anything else (unknown account, someone
   * else's family, an unknown or already ended one) is `false`, never an error, so a forged
   * callback learns nothing.
   */
  async endSessionFromBot(input: {
    readonly telegramId: bigint;
    readonly familyId: string;
    readonly now: Date;
  }): Promise<boolean> {
    const user = await this.users.findByTelegramId(input.telegramId);
    if (user === null) return false;
    const revoked = await this.repo.revokeFamily({
      userId: user.id,
      familyId: input.familyId,
      now: input.now,
    });
    // The revoke runs under the family lock, so 0 really means "no live row" (not "a refresh
    // slipped a new one in"): only then is the honest answer "already ended".
    if (revoked === 0) return false;
    this.logger.warn(
      `security event=SESSION_ENDED_FROM_BOT userId=${user.id} familyId=${input.familyId}`,
    );
    return true;
  }

  /**
   * Revokes the family inside the caller's transaction (used with the LoginRequest update).
   * Takes the family lock inside `tx`; callers that also lock a LoginRequest row must do so
   * first (that is the only order that exists, see OtpLoginService.endUsedLogin).
   */
  revokeFamilyIn(ref: FamilyRef & { readonly now: Date }, tx: Db): Promise<number> {
    return this.repo.revokeFamily(ref, tx);
  }

  /**
   * Logout by the refresh cookie. Idempotent and silent: an unknown, expired or already revoked
   * token just means there is nothing left to end.
   */
  async revokeByRefreshToken(refreshToken: string, now: Date): Promise<void> {
    if (!REFRESH_TOKEN_SHAPE.test(refreshToken)) return;
    const row = await this.repo.findByHash(this.hashRefresh(refreshToken));
    if (row !== null) {
      await this.repo.revokeFamily({ familyId: row.familyId, userId: row.userId, now });
    }
  }

  /** The user's active sessions, most recently used first. */
  async listSessions(
    userId: string,
    currentFamilyId: string | undefined,
    now: Date,
  ): Promise<SessionItem[]> {
    const active = await this.repo.listActive(userId, now, MAX_LISTED_SESSIONS);
    const byFamily = new Map(active.map((row) => [row.familyId, row]));
    const bounds = await this.repo.familyBounds(userId, [...byFamily.keys()]);
    return bounds
      .flatMap((b): SessionItem[] => {
        const row = byFamily.get(b.familyId);
        if (row === undefined) return [];
        return [
          {
            id: b.familyId,
            userAgent: row.userAgent,
            ipMasked: row.ip,
            createdAt: b.createdAt.toISOString(),
            lastUsedAt: b.lastUsedAt.toISOString(),
            current: b.familyId === currentFamilyId,
          },
        ];
      })
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  private async insertRow(
    userId: string,
    familyId: string,
    meta: SessionMeta,
    now: Date,
    tx?: Db,
  ): Promise<string> {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.repo.insert(
      {
        userId,
        familyId,
        refreshHash: this.hashRefresh(refreshToken),
        userAgent: truncateUserAgent(meta.userAgent),
        ip: maskIp(meta.ip),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SEC * MS),
        createdAt: now,
      },
      tx,
    );
    return refreshToken;
  }

  // Keyed hash: a leaked table alone cannot be used to forge or look up tokens offline.
  private hashRefresh(token: string): string {
    return createHmac('sha256', this.refreshSecret).update(token).digest('hex');
  }
}
