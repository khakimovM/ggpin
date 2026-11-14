import { Injectable } from '@nestjs/common';
import { transitionOrder, type AttemptStatus, type Prisma, type Tx } from '@repo/db';
import type { OrderStatusReason } from '@repo/shared';
import { isUniqueViolation } from '../bank-feed/prisma-errors';
import { PrismaService } from '../infra/prisma/prisma.service';
import { isGuardRefusal } from '../ton/ton-db-errors';
import { lockAttempt, lockOrder } from '../ton/ton-row-locks';
import { storedObject } from './attempt-json';
import { isAttemptHoldError } from './held-policy';

// FulfillmentAttempt writes of the core. Each runs in ONE transaction under the row locks of
// docs/06 "Qulf tartibi" (order -> attempt), re-checks what it relies on, and lets the database
// guards of migrations 10/11 have the last word (one live attempt per order, forward-only status,
// CONFIRMED only together with DELIVERED: N1-B). A write that finds the rows moved returns a
// "stale" answer instead of throwing; the caller re-reads.

export interface AttemptRow {
  readonly id: string;
  readonly attemptNo: number;
  readonly adapter: string;
  readonly status: AttemptStatus;
  readonly externalRef: string | null;
  readonly request: Prisma.JsonValue;
  readonly response: Prisma.JsonValue | null;
  readonly error: string | null;
}

const ATTEMPT_SELECT = {
  id: true,
  attemptNo: true,
  adapter: true,
  status: true,
  externalRef: true,
  request: true,
  response: true,
  error: true,
} satisfies Prisma.FulfillmentAttemptSelect;

export interface NewAttempt {
  readonly orderId: string;
  readonly attemptNo: number;
  readonly adapter: string;
  readonly request: Prisma.InputJsonObject;
  readonly externalRef: string | null;
  readonly costMinor: bigint;
  /** What the PURCHASE entry of the order must carry (negative tiyin). */
  readonly purchaseTiyin: bigint;
}

export type CreateResult =
  | { readonly kind: 'CREATED'; readonly attempt: AttemptRow }
  /** The order left PROCESSING, or another run committed a live attempt first. */
  | { readonly kind: 'STALE' }
  /** No PURCHASE debit of the paid amount (S2 audit M1): nothing may leave for this order. */
  | { readonly kind: 'NO_PURCHASE' };

export type FailHoldResult =
  | { readonly kind: 'HELD'; readonly eventId: string }
  /** The attempt owns a TON transfer after all: it may have been sent, never failed here. */
  | { readonly kind: 'HAS_TRANSFER' }
  | { readonly kind: 'STALE' };

const OPEN: readonly AttemptStatus[] = ['SENDING', 'SENT'];

@Injectable()
export class AttemptsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(orderId: string): Promise<AttemptRow[]> {
    return this.prisma.client.fulfillmentAttempt.findMany({
      where: { orderId },
      orderBy: { attemptNo: 'asc' },
      select: ATTEMPT_SELECT,
    });
  }

  /** rules/45 step 5: SENDING is committed before anything is signed or sent. */
  async createSending(input: NewAttempt): Promise<CreateResult> {
    try {
      return await this.prisma.client.$transaction(async (tx): Promise<CreateResult> => {
        const order = await lockOrder(tx, input.orderId);
        if (order?.status !== 'PROCESSING') return { kind: 'STALE' };
        const purchase = await tx.ledgerEntry.findUnique({
          where: {
            refType_refId_kind: { refType: 'ORDER', refId: input.orderId, kind: 'PURCHASE' },
          },
          select: { amountTiyin: true },
        });
        if (purchase?.amountTiyin !== input.purchaseTiyin) return { kind: 'NO_PURCHASE' };
        const attempt = await tx.fulfillmentAttempt.create({
          data: {
            orderId: input.orderId,
            attemptNo: input.attemptNo,
            adapter: input.adapter,
            status: 'SENDING',
            request: input.request,
            externalRef: input.externalRef,
            costMinor: input.costMinor,
          },
          select: ATTEMPT_SELECT,
        });
        return { kind: 'CREATED', attempt };
      });
    } catch (error) {
      // FulfillmentAttempt_order_active_key / (orderId, attemptNo): another run was first.
      if (isUniqueViolation(error) || isGuardRefusal(error)) return { kind: 'STALE' };
      throw error;
    }
  }

  /** SENDING -> SENT with the supplier's answer (the reference was committed with SENDING). */
  async markSent(attemptId: string, response: Prisma.InputJsonObject): Promise<boolean> {
    const moved = await this.prisma.client.fulfillmentAttempt.updateMany({
      where: { id: attemptId, status: 'SENDING' },
      data: { status: 'SENT', response },
    });
    return moved.count === 1;
  }

  /** Attempt CONFIRMED and order DELIVERED in ONE transaction (N1-B, the deferred SQL check). */
  async deliver(orderId: string, attemptId: string, response: Prisma.InputJsonObject) {
    return this.prisma.client.$transaction(async (tx): Promise<boolean> => {
      const attempt = await this.lockOpen(tx, orderId, attemptId);
      if (attempt === null) return false;
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: { status: 'CONFIRMED', response: { ...storedObject(attempt.response), ...response } },
      });
      await transitionOrder(tx, {
        orderId,
        from: 'PROCESSING',
        to: 'DELIVERED',
        actor: 'system',
      });
      return true;
    });
  }

  /**
   * The outcome is unknown: the attempt (when still SENDING / SENT) becomes UNKNOWN and the order
   * NEEDS_REVIEW, in one transaction (plan 6.3). Only the reconciler or an operator leaves it.
   */
  async toReview(
    orderId: string,
    attemptId: string | null,
    reason: OrderStatusReason,
    response: Prisma.InputJsonObject = {},
  ): Promise<boolean> {
    return this.prisma.client.$transaction(async (tx): Promise<boolean> => {
      const order = await lockOrder(tx, orderId);
      if (order?.status !== 'PROCESSING') return false;
      if (attemptId !== null) {
        const attempt = await lockAttempt(tx, attemptId);
        if (attempt !== null && OPEN.includes(attempt.status)) {
          await tx.fulfillmentAttempt.update({
            where: { id: attemptId },
            data: {
              status: 'UNKNOWN',
              response: { ...storedObject(attempt.response), ...response },
            },
          });
        }
      }
      await transitionOrder(tx, {
        orderId,
        from: 'PROCESSING',
        to: 'NEEDS_REVIEW',
        actor: 'system',
        reason,
        note: `fulfill: outcome unknown (${reason})`,
      });
      return true;
    });
  }

  /** A PROVEN "not sent" supplier attempt (proof stored): FAILED, the order stays PROCESSING. */
  async failProven(
    orderId: string,
    attemptId: string,
    error: string,
    response: Prisma.InputJsonObject,
  ): Promise<boolean> {
    return this.prisma.client.$transaction(async (tx): Promise<boolean> => {
      const attempt = await this.lockOpen(tx, orderId, attemptId);
      if (attempt === null || (await this.hasTransfer(tx, attemptId))) return false;
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'FAILED',
          error,
          response: { ...storedObject(attempt.response), ...response },
        },
      });
      return true;
    });
  }

  /**
   * The wallet stayed unusable through the last retry and nothing was signed for this attempt:
   * attempt FAILED (no transfer, no reference) and the order HELD in one transaction.
   */
  async failAndHold(
    orderId: string,
    attemptId: string,
    error: string,
    reason: OrderStatusReason,
    note: string,
  ): Promise<FailHoldResult> {
    return this.prisma.client.$transaction(async (tx): Promise<FailHoldResult> => {
      const attempt = await this.lockOpen(tx, orderId, attemptId);
      if (attempt?.status !== 'SENDING') return { kind: 'STALE' };
      if (attempt.externalRef !== null || (await this.hasTransfer(tx, attemptId))) {
        return { kind: 'HAS_TRANSFER' };
      }
      await tx.fulfillmentAttempt.update({
        where: { id: attemptId },
        data: { status: 'FAILED', error },
      });
      const { eventId } = await transitionOrder(tx, {
        orderId,
        from: 'PROCESSING',
        to: 'HELD',
        actor: 'system',
        reason,
        note,
      });
      return { kind: 'HELD', eventId };
    });
  }

  /** The order's last attempt when an attempt hold failed it (held-policy.ts), else null. */
  async latestAttemptHold(orderId: string): Promise<AttemptRow | null> {
    const last = await this.prisma.client.fulfillmentAttempt.findFirst({
      where: { orderId },
      orderBy: { attemptNo: 'desc' },
      select: ATTEMPT_SELECT,
    });
    if (last?.status !== 'FAILED' || !isAttemptHoldError(last.error)) return null;
    return last;
  }

  /** The TON transfer the attempt signed, or null (one per attempt: TonTransfer.attemptId). */
  async transferIdOf(attemptId: string): Promise<string | null> {
    const transfer = await this.prisma.client.tonTransfer.findUnique({
      where: { attemptId },
      select: { id: true },
    });
    return transfer?.id ?? null;
  }

  /** How long ago the attempt was committed, by the database's own clock (docs/06 L1). */
  async ageMs(attemptId: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ ms: string }[]>`
      SELECT floor(extract(epoch from (timezone('UTC', now()) - "createdAt")) * 1000)::bigint::text
        AS "ms" FROM "FulfillmentAttempt" WHERE "id" = ${attemptId}`;
    const ms = Number(rows[0]?.ms);
    if (!Number.isSafeInteger(ms)) throw new Error('the attempt age could not be read');
    return ms;
  }

  /** Order PROCESSING and the attempt (of that order) SENDING or SENT, both locked; else null. */
  private async lockOpen(tx: Tx, orderId: string, attemptId: string) {
    const order = await lockOrder(tx, orderId);
    if (order?.status !== 'PROCESSING') return null;
    const attempt = await lockAttempt(tx, attemptId);
    if (attempt?.orderId !== orderId || !OPEN.includes(attempt.status)) return null;
    return attempt;
  }

  private async hasTransfer(tx: Tx, attemptId: string): Promise<boolean> {
    const transfer = await tx.tonTransfer.findUnique({
      where: { attemptId },
      select: { id: true },
    });
    return transfer !== null;
  }
}
