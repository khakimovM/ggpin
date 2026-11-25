import { Inject, Injectable } from '@nestjs/common';
import { failAndRefundOrder, transitionOrder, type RefundOutcome, type Tx } from '@repo/db';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { isDeadlock } from '../../ton/ton-db-errors';
import type { PrismaHolder } from '../../ton/ton-transfer.repository';
import {
  HELD_EXPIRED_NOTE,
  RECONCILE_RELEASE_NOTE_PREFIX,
  type ReleasableReason,
} from './held-release-policy';
import { assertHeldPayoutClean } from './held-payout';

// The HELD step's two writes (phase 5 S9e, plan §4.1-§4.3), each ONE transaction:
// - refund: HELD -> FAILED (HELD_EXPIRED) -> REFUNDED + the REFUND entry, ONLY through
//   `failAndRefundOrder` (wallet row locked first, then the order; it refuses when a payout may
//   have gone out (LivePayoutError) or the PURCHASE entry does not add up). `actor: system`: the
//   state machine lets only system or admin take HELD -> FAILED and FAILED -> REFUNDED;
// - release: HELD -> QUEUED through `transitionOrder` (the state machine and the compare-and-set),
//   actor system with the note `reconcile release: <REASON>`, which the release cap counts. No
//   money moves. The fulfill-order job is queued by the step AFTER the commit.
// Both re-count the order's HELD events under the row lock the move just took: a decision made on
// one hold is never applied to another (released by an operator and held again in between), the
// whole transaction rolls back (HoldChangedError). Both also read the order's payout rows again
// in the move's transaction (S9f M-1 / L-1, held-payout.ts): a late chain fact or a transfer that
// is not EXPIRED rolls the move back (HeldPayoutError), even one committed after the decision. The
// refund reads them FIRST: `failAndRefundOrder` refuses the same rows under the order lock
// (LivePayoutError, a late fact included since the owner's 2026-11-18 decision), and the precise
// error keeps the owner's reminder daily (guard-ref.ts `heldlate` / `heldlive`); a fact committed between that
// read and the lock still meets the lock's check. The release reads them under the row lock its
// move took. A deadlock (40P01) rolled everything back: the transaction runs again (3 tries).
// Every other error propagates unchanged (the step maps them).

const DEADLOCK_TRIES = 3;

/** The order is in another hold than the one the decision was made on: nothing was written. */
export class HoldChangedError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId}: the hold changed under the reconciler, rolled back`);
    this.name = 'HoldChangedError';
  }
}

@Injectable()
export class HeldWriter {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  /** `heldEvents`: how many HELD events the order had when the decision was made. */
  refund(orderId: string, heldEvents: number): Promise<RefundOutcome> {
    return this.inTransaction(async (tx) => {
      await assertHeldPayoutClean(tx, orderId);
      const outcome = await failAndRefundOrder(tx, {
        orderId,
        from: 'HELD',
        reason: 'HELD_EXPIRED',
        actor: 'system',
        note: HELD_EXPIRED_NOTE,
      });
      await this.sameHold(tx, orderId, heldEvents);
      return outcome;
    });
  }

  release(orderId: string, reason: ReleasableReason, heldEvents: number): Promise<void> {
    return this.inTransaction(async (tx) => {
      await transitionOrder(tx, {
        orderId,
        from: 'HELD',
        to: 'QUEUED',
        actor: 'system',
        note: `${RECONCILE_RELEASE_NOTE_PREFIX}${reason}`,
      });
      await this.sameHold(tx, orderId, heldEvents);
      await assertHeldPayoutClean(tx, orderId);
    });
  }

  private async sameHold(tx: Tx, orderId: string, heldEvents: number): Promise<void> {
    const now = await tx.orderEvent.count({ where: { orderId, to: 'HELD' } });
    if (now !== heldEvents) throw new HoldChangedError(orderId);
  }

  private async inTransaction<T>(write: (tx: Tx) => Promise<T>): Promise<T> {
    for (let tries = 1; ; tries += 1) {
      try {
        return await this.prisma.client.$transaction(write);
      } catch (error) {
        if (!isDeadlock(error) || tries >= DEADLOCK_TRIES) throw error;
      }
    }
  }
}
