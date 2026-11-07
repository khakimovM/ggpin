import { Injectable } from '@nestjs/common';
import {
  usedTopupBaseSince,
  type IntentStatus,
  type Locale,
  type PaymentIntent,
  type TopupCard,
} from '@repo/db';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

const P2P = 'P2P_CARD' as const;

export type IntentWithCard = PaymentIntent & { readonly card: TopupCard | null };

export interface IntentOwner {
  readonly id: string;
  readonly createdAt: Date;
  readonly locale: Locale;
  readonly firstName: string | null;
  readonly username: string | null;
}

export interface NewIntentData {
  readonly userId: string;
  readonly cardId: string;
  readonly baseAmountTiyin: bigint;
  readonly amountTiyin: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly reservedUntil: Date;
}

export type PayGate = Pick<
  PaymentIntent,
  'id' | 'provider' | 'status' | 'expiresAt' | 'payTokenHash' | 'userId'
>;

export type PayDetails = IntentWithCard & {
  readonly user: { firstName: string | null; username: string | null; isBlocked: boolean };
};

/** Rows of a rolling-window limit, oldest first, at most `take` of them. */
export interface WindowRows {
  readonly count: number;
  /** The earliest moment among them (createdAt or reservedUntil, per query). */
  readonly earliest: Date | null;
}

// All Prisma access for top-up intents. Every user-facing read is scoped by `userId` (the
// session's), so another user's intent is simply not found (404). Writes that race with the
// worker (cancel, token rotation, lazy expiry) are conditional `updateMany`s: they change the
// row only while it is still in the state the caller saw, and report whether they did.
@Injectable()
export class TopupIntentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findOwner(userId: string): Promise<IntentOwner | null> {
    return this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true, locale: true, firstName: true, username: true },
    });
  }

  findByKey(userId: string, idempotencyKey: string): Promise<IntentWithCard | null> {
    return this.prisma.client.paymentIntent.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      include: { card: true },
    });
  }

  findPending(userId: string): Promise<PaymentIntent | null> {
    return this.prisma.client.paymentIntent.findFirst({
      where: { userId, provider: P2P, status: 'PENDING' },
    });
  }

  findOwn(userId: string, id: string): Promise<IntentWithCard | null> {
    return this.prisma.client.paymentIntent.findFirst({
      where: { id, userId, provider: P2P },
      include: { card: true },
    });
  }

  listOwn(
    userId: string,
    status: IntentStatus | undefined,
    limit: number,
  ): Promise<IntentWithCard[]> {
    return this.prisma.client.paymentIntent.findMany({
      where: { userId, provider: P2P, ...(status === undefined ? {} : { status }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: { card: true },
    });
  }

  /**
   * Pay view, step 1: only what the token check needs, by primary key. The same single query
   * runs for an unknown id (the dummy id of a malformed request included) and a real one.
   */
  findPayGate(id: string): Promise<PayGate | null> {
    return this.prisma.client.paymentIntent.findUnique({
      where: { id },
      select: {
        id: true,
        provider: true,
        status: true,
        expiresAt: true,
        payTokenHash: true,
        userId: true,
      },
    });
  }

  /** Pay view, step 2, only after the token matched: the card and what may be shown of the owner. */
  findPayDetails(id: string): Promise<PayDetails | null> {
    return this.prisma.client.paymentIntent.findUnique({
      where: { id },
      include: {
        card: true,
        user: { select: { firstName: true, username: true, isBlocked: true } },
      },
    });
  }

  /**
   * PENDING -> EXPIRED for every request in `scope` whose deadline has passed: the ONE
   * definition of "overdue" (`expiresAt <= now`; a request is live while `now < expiresAt`, the
   * same half-open bound the pay view, the token rotation and cancel use). Every read and write
   * of the session routes runs it first, so none of them ever shows or acts on an overdue
   * PENDING; the worker's sweep (S9) must use the same predicate. Returns how many it expired.
   */
  async expireOverdue(now: Date, scope: { readonly userId?: string; readonly id?: string }) {
    const { count } = await this.prisma.client.paymentIntent.updateMany({
      where: { ...scope, provider: P2P, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    return count;
  }

  /** UNPAID reservations held now: PENDING, or EXPIRED/CANCELLED with reservedUntil > now. */
  async unpaidReserved(userId: string, now: Date, take: number): Promise<WindowRows> {
    const rows = await this.prisma.client.paymentIntent.findMany({
      where: {
        userId,
        provider: P2P,
        OR: [
          { status: 'PENDING' },
          { status: { in: ['EXPIRED', 'CANCELLED'] }, reservedUntil: { gt: now } },
        ],
      },
      orderBy: { reservedUntil: 'asc' },
      take,
      select: { reservedUntil: true },
    });
    return { count: rows.length, earliest: rows[0]?.reservedUntil ?? null };
  }

  /** Intents the user CREATED since `since` (refused attempts create none). */
  async createdSince(userId: string, since: Date, take: number): Promise<WindowRows> {
    const rows = await this.prisma.client.paymentIntent.findMany({
      where: { userId, provider: P2P, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take,
      select: { createdAt: true },
    });
    return { count: rows.length, earliest: rows[0]?.createdAt ?? null };
  }

  /** Base amounts counted by the daily caps (topup-limits.ts in shared): PAID by paidAt, PENDING by createdAt. */
  // The query is shared with the worker's credit-time re-check (@repo/db `usedTopupBaseSince`).
  usedBaseSince(userId: string, since: Date): Promise<bigint> {
    return usedTopupBaseSince(this.prisma.client, userId, since);
  }

  /**
   * Inserts the intent and stores its token hash. Two statements because the hash binds the
   * id, which the database generates; both run in the caller's card-locked transaction.
   */
  async insert(
    tx: Db,
    data: NewIntentData,
    hashFor: (intentId: string) => string,
  ): Promise<IntentWithCard> {
    const created = await tx.paymentIntent.create({
      data: {
        userId: data.userId,
        provider: P2P,
        purpose: 'TOPUP',
        status: 'PENDING',
        cardId: data.cardId,
        baseAmountTiyin: data.baseAmountTiyin,
        amountTiyin: data.amountTiyin,
        idempotencyKey: data.idempotencyKey,
        requestHash: data.requestHash,
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
        reservedUntil: data.reservedUntil,
      },
      select: { id: true },
    });
    return tx.paymentIntent.update({
      where: { id: created.id },
      data: { payTokenHash: hashFor(created.id) },
      include: { card: true },
    });
  }

  /** New token hash while the intent is still PENDING and unexpired; false otherwise. */
  async rotateToken(userId: string, id: string, hash: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.client.paymentIntent.updateMany({
      where: { id, userId, provider: P2P, status: 'PENDING', expiresAt: { gt: now } },
      data: { payTokenHash: hash },
    });
    return count === 1;
  }

  /** PENDING and unexpired -> CANCELLED, and the pay link dies with it (hash NULL). */
  async cancel(userId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.client.paymentIntent.updateMany({
      where: { id, userId, provider: P2P, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'CANCELLED', payTokenHash: null },
    });
    return count === 1;
  }
}
