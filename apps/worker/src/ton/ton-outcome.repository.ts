import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@repo/db';
import { orderStatusReasonSchema } from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';
import { isDeadlock } from './ton-db-errors';
import {
  writeOutcome,
  type OutcomeRows,
  type SelftestExpiryMemory,
  type TonOutcome,
} from './ton-outcome-writes';
import { isUnresolved, type PayoutState } from './ton-payout';
import { hasWitnessConflict, lockAttempt, lockOrder, lockTransfer } from './ton-row-locks';
import type { PrismaHolder } from './ton-transfer.repository';

// Writes what the chain decided about ONE unresolved transfer, in one transaction with the order
// and attempt changes the database demands together with it (docs/06 "5-faza S1"):
// - CONFIRMED: transfer CONFIRMED + attempt CONFIRMED + order DELIVERED (N1-B: only together);
// - BOUNCED / CONSUMED_UNMATCHED / SUSPECT / WITNESS_CONFLICT / TIMEOUT: order NEEDS_REVIEW,
//   attempt UNKNOWN (the transfer BOUNCED or CONSUMED_UNMATCHED; SUSPECT, WITNESS_CONFLICT and
//   TIMEOUT leave it unresolved for the reconciler: ONCHAIN_FAILED needs a second source, R2a);
//   after a WITNESS_CONFLICT the transfer is never written EXPIRED (review RR2-4);
// - EXPIRY_SEEN: the first observation is kept; a second one, consistent and later (D-60 (2)),
//   writes transfer EXPIRED + attempt FAILED (provably never sent; the order stays PROCESSING and
//   the fulfillment core decides the next attempt or the refund).
// An order that is already NEEDS_REVIEW is never moved (only resolveNeedsReview may): just the
// transfer and the attempt's facts are written. Locks: order -> attempt -> transfer, the order
// BEFORE the BOUNCED update (R4-1); a deadlock (40P01) rolls everything back and is retried.

export type { TonOutcome } from './ton-outcome-writes';

export interface AppliedOutcome {
  /** False: nothing was written (already decided by another check, or nothing new). */
  readonly applied: boolean;
  readonly state: PayoutState;
}

const DEADLOCK_TRIES = 3;

/** The current rows of a transfer (inside a transaction they are the locked ones). */
export async function readPayoutState(
  db: Pick<Tx, 'tonTransfer'>,
  transferId: string,
  conflictInMemory = false,
): Promise<PayoutState> {
  const row = await db.tonTransfer.findUniqueOrThrow({
    where: { id: transferId },
    select: {
      status: true,
      txHash: true,
      attempt: {
        select: {
          status: true,
          response: true,
          order: { select: { id: true, status: true, statusReason: true } },
        },
      },
    },
  });
  const order = row.attempt?.order ?? null;
  const reason = orderStatusReasonSchema.safeParse(order?.statusReason);
  return {
    transferId,
    transferStatus: row.status,
    txHash: row.txHash,
    orderId: order?.id ?? null,
    orderStatus: order?.status ?? null,
    orderReason: reason.success ? reason.data : null,
    attemptStatus: row.attempt?.status ?? null,
    witnessConflict: conflictInMemory || hasWitnessConflict(row.attempt?.response ?? null),
  };
}

@Injectable()
export class TonOutcomeRepository {
  private readonly selftestExpiry: SelftestExpiryMemory = {
    firsts: new Map(),
    conflicts: new Set(),
  };

  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  async apply(transferId: string, outcome: TonOutcome): Promise<AppliedOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction((tx) => this.applyIn(tx, transferId, outcome));
      } catch (error) {
        if (!isDeadlock(error) || attempt >= DEADLOCK_TRIES) throw error;
      }
    }
  }

  stateOf(transferId: string): Promise<PayoutState> {
    return this.read(this.prisma.client, transferId);
  }

  /** A SELFTEST transfer's witness conflict lives in this process's memory (no attempt). */
  private read(db: Pick<Tx, 'tonTransfer'>, transferId: string): Promise<PayoutState> {
    return readPayoutState(db, transferId, this.selftestExpiry.conflicts.has(transferId));
  }

  private async applyIn(tx: Tx, transferId: string, outcome: TonOutcome): Promise<AppliedOutcome> {
    const head = await tx.tonTransfer.findUniqueOrThrow({
      where: { id: transferId },
      select: { attemptId: true, attempt: { select: { orderId: true } } },
    });
    const orderId = head.attempt?.orderId ?? null;
    const order = orderId === null ? null : await lockOrder(tx, orderId);
    const attempt = head.attemptId === null ? null : await lockAttempt(tx, head.attemptId);
    const transfer = await lockTransfer(tx, transferId);
    if (transfer === null) throw new Error(`TonTransfer ${transferId} disappeared`);
    if (!isUnresolved(transfer)) {
      this.selftestExpiry.firsts.delete(transferId);
      return { applied: false, state: await this.read(tx, transferId) };
    }
    const rows: OutcomeRows = {
      transferId,
      transfer,
      orderId,
      order,
      attemptId: head.attemptId,
      attempt,
    };
    const applied = await writeOutcome(tx, rows, outcome, this.selftestExpiry);
    return { applied, state: await this.read(tx, transferId) };
  }
}
