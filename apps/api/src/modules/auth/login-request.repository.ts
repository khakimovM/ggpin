import { Injectable } from '@nestjs/common';
import type { LoginRequest } from '@repo/db';
import { LOGIN_NONCE_TTL_SEC, OTP_CODE_TTL_SEC, OTP_MAX_ATTEMPTS } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface AttemptSnapshot {
  readonly id: string;
  /** Attempts used including the one just registered. */
  readonly attempts: number;
  readonly codeHash: string | null;
  readonly telegramId: bigint | null;
}

export interface CodeRelease {
  readonly nonce: string;
  readonly telegramId: bigint;
  /** HMAC of the code that failed to reach the user; the row is only released if it still holds it. */
  readonly codeHash: string;
  readonly now: Date;
}

export interface CodeClaim {
  readonly nonce: string;
  readonly telegramId: bigint;
  readonly codeHash: string;
  /** When the code stops being valid (sent at + OTP_CODE_TTL_SEC). */
  readonly codeExpiresAt: Date;
  readonly now: Date;
}

const MS = 1000;

// All Prisma access for web/bot login requests. Every state change is a single guarded
// `updateMany` (the WHERE carries status, expiry and attempts) and the returned count, not a
// prior read, decides the outcome: that is what keeps parallel requests honest.
@Injectable()
export class LoginRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  /** `createdAt` is the injected clock's now (not the DB default): release derives expiry from it. */
  async create(input: { nonce: string; now: Date; expiresAt: Date }): Promise<void> {
    await this.prisma.client.loginRequest.create({
      data: {
        nonce: input.nonce,
        kind: 'USER',
        status: 'PENDING',
        expiresAt: input.expiresAt,
        createdAt: input.now,
      },
    });
  }

  findByNonce(nonce: string, db: Db = this.prisma.client): Promise<LoginRequest | null> {
    return db.loginRequest.findUnique({ where: { nonce } });
  }

  /**
   * Serialises code issuing per Telegram account for the length of the surrounding transaction,
   * so the "count recent codes, then claim" pair cannot be raced past the limit. Parameterised
   * raw SQL: Prisma has no advisory-lock API.
   */
  async lockTelegramId(telegramId: bigint, db: Db): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`otp-issue:${telegramId.toString()}`}, 0))`;
  }

  /**
   * Codes issued to this account at or after `issuedSince`. `telegramId` and `codeHash` are only
   * ever written together when a code is issued (a released code clears both and stops
   * counting), and that same write sets
   * `expiresAt = sentAt + OTP_CODE_TTL_SEC` (nothing else moves `expiresAt` afterwards), so
   * `sentAt >= issuedSince` is `expiresAt >= issuedSince + TTL`. Rows in any final state count:
   * a used or denied code was still sent.
   */
  countCodesIssuedSince(telegramId: bigint, issuedSince: Date, db: Db): Promise<number> {
    return db.loginRequest.count({
      where: {
        kind: 'USER',
        telegramId,
        codeHash: { not: null },
        expiresAt: { gte: new Date(issuedSince.getTime() + OTP_CODE_TTL_SEC * MS) },
      },
    });
  }

  /** PENDING -> CODE_SENT for this account; false when the request is no longer claimable. */
  async claimForCode(claim: CodeClaim, db: Db): Promise<boolean> {
    const { count } = await db.loginRequest.updateMany({
      where: {
        nonce: claim.nonce,
        kind: 'USER',
        status: 'PENDING',
        expiresAt: { gt: claim.now },
        OR: [{ telegramId: null }, { telegramId: claim.telegramId }],
      },
      data: {
        status: 'CODE_SENT',
        telegramId: claim.telegramId,
        codeHash: claim.codeHash,
        expiresAt: claim.codeExpiresAt,
        attempts: 0,
      },
    });
    return count === 1;
  }

  /** CODE_SENT -> DENIED, only for the account that holds the code. */
  async deny(nonce: string, telegramId: bigint, now: Date): Promise<boolean> {
    const { count } = await this.prisma.client.loginRequest.updateMany({
      where: { nonce, kind: 'USER', status: 'CODE_SENT', telegramId, expiresAt: { gt: now } },
      data: { status: 'DENIED' },
    });
    return count === 1;
  }

  /**
   * CODE_SENT -> PENDING when the bot could not deliver the code. Guarded by account, code hash
   * and attempts = 0, so it can only undo a code nobody has tried yet. The nonce goes back to
   * its own lifetime (createdAt + LOGIN_NONCE_TTL_SEC) and forgets the account and the hash, so
   * the same link can be opened again. Raw SQL because the new expiry is derived from a column
   * of the same row; every value is a bound parameter.
   */
  async release(release: CodeRelease): Promise<boolean> {
    const { nonce, telegramId, codeHash, now } = release;
    const count = await this.prisma.client.$executeRaw`
      UPDATE "LoginRequest"
      SET "status" = 'PENDING',
          "telegramId" = NULL,
          "codeHash" = NULL,
          "expiresAt" = "createdAt" + (${LOGIN_NONCE_TTL_SEC}::int * interval '1 second'),
          "updatedAt" = ${now}
      WHERE "nonce" = ${nonce}
        AND "kind" = 'USER'
        AND "status" = 'CODE_SENT'
        AND "telegramId" = ${telegramId}
        AND "codeHash" = ${codeHash}
        AND "attempts" = 0`;
    return count === 1;
  }

  /**
   * USED -> DENIED for the account that used the code ("this was not me" after sign-in). Keeps
   * `sessionFamilyId` (the CHECK allows it on DENIED) so a replay can be told apart.
   */
  async denyUsed(nonce: string, telegramId: bigint, db: Db): Promise<boolean> {
    const { count } = await db.loginRequest.updateMany({
      where: { nonce, kind: 'USER', status: 'USED', telegramId, sessionFamilyId: { not: null } },
      data: { status: 'DENIED' },
    });
    return count === 1;
  }

  /** Records which web session a USED request opened; part of the same transaction as markUsed. */
  async linkSession(id: string, sessionFamilyId: string, db: Db): Promise<boolean> {
    const { count } = await db.loginRequest.updateMany({
      where: { id, status: 'USED', sessionFamilyId: null },
      data: { sessionFamilyId },
    });
    return count === 1;
  }

  /**
   * Counts one verification attempt, atomically, and returns the row as it stands right after
   * (null when the request cannot take an attempt: unknown, wrong state, expired or all
   * OTP_MAX_ATTEMPTS used). The UPDATE's WHERE holds the cap, so N parallel guesses can never
   * push `attempts` past the limit. The read happens in the same short transaction, while our
   * row lock is held, so `attempts` is exactly this call's own count.
   */
  registerAttempt(nonce: string, now: Date): Promise<AttemptSnapshot | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.loginRequest.updateMany({
        where: {
          nonce,
          kind: 'USER',
          status: 'CODE_SENT',
          expiresAt: { gt: now },
          attempts: { lt: OTP_MAX_ATTEMPTS },
        },
        data: { attempts: { increment: 1 } },
      });
      if (count !== 1) return null;
      return tx.loginRequest.findUnique({
        where: { nonce },
        select: { id: true, attempts: true, codeHash: true, telegramId: true },
      });
    });
  }

  /** CODE_SENT -> USED; exactly one of several parallel correct verifications gets true. */
  async markUsed(id: string, now: Date, db: Db): Promise<boolean> {
    const { count } = await db.loginRequest.updateMany({
      where: { id, status: 'CODE_SENT', expiresAt: { gt: now } },
      data: { status: 'USED' },
    });
    return count === 1;
  }
}
