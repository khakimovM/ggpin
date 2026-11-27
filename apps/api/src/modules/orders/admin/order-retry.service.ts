import { Inject, Injectable } from '@nestjs/common';
import { OrderRetryAuditSchema, sendAttemptsUsed, type NumberedAttemptRow } from '@repo/shared';
import { checkedId, checkedReason, validationError } from '../../../common/admin/admin-input';
import { AppError } from '../../../common/exceptions/app-error';
import { OrderAdminEffects, type RequeueResult } from './order-admin-effects';
import { asRefusal, retryOnDeadlock } from './order-admin-errors';
import { ORDER_RETRY_ACTION, OrderAdminRepository } from './order-admin.repository';
import {
  CLI_OWNER_AUDIT_ACTOR,
  OPERATOR_CHANNEL,
  assertOwnerChannel,
  checkedActor,
  type OperatorChannel,
} from './operator-channel';

export interface RetryInput {
  readonly orderId: string;
  readonly reason: string;
  readonly operator: string;
  readonly ip?: string | null;
  readonly osUser?: string | null;
}

export interface RetryOutcome {
  /** False: an earlier run already released it (the order is QUEUED by the operator). */
  readonly applied: boolean;
  readonly orderId: string;
  readonly auditId: string | null;
  /** QUEUED: a job will run; RUNNING: the old job is still running (re-run later); FAILED. */
  readonly job: RequeueResult;
  readonly adminAction: boolean;
  /**
   * Applied only: how many of the order's attempts were proven NOT sent before this release (all
   * of them, earlier releases included). The CLI warns: the release starts the worker's count again.
   */
  readonly attemptsUsed: number | null;
}

/** The highest `attemptNo` of the order (0: none): where the worker's next count starts. */
function maxAttemptNoOf(attempts: readonly NumberedAttemptRow[]): number {
  return attempts.reduce((max, attempt) => Math.max(max, attempt.attemptNo), 0);
}

/** The release row in the shared shape (OrderRetryAuditSchema), or a throw: nothing is written. */
export function assertRetryAuditShape(before: object, after: object): void {
  if (!OrderRetryAuditSchema.safeParse({ before, after }).success) {
    throw new Error('order:retry: the release audit row does not match OrderRetryAuditSchema');
  }
}

const OPERATOR_RELEASE_NOTE = 'operator retry';

/**
 * `order:retry` (phase 5 S10): HELD -> QUEUED by the owner, then fulfill-order through the one
 * enqueuer (jobId = orderId). The status is re-read under the order lock and the move is the state
 * machine's compare-and-set (`transitionOrder`); the AuditLog (ORDER_RETRY) is written in the same
 * transaction. No money moves here (the worker re-checks price, limits and the recipient before
 * any payout), so no owner code is asked. A re-run after the release only queues the job again
 * (idempotent by jobId).
 *
 * This is the OWNER's release (phase 5 S9b, D-64 (5), D-66 (2)): it also starts the attempt cap
 * again. The audit row stores `before.maxAttemptNo`, the highest attempt number read under the
 * order lock (no attempt can be added while the order is HELD), and `after.actor` = CLI / OWNER.
 * The worker then counts only attempts numbered above it (shared attempt-limit.ts), so a release
 * gives at most MAX_SEND_ATTEMPTS new attempts, each made only after the previous one was proven
 * NOT sent: never a second payout. A re-run against the released (QUEUED) order writes nothing,
 * so it gives no further attempt.
 */
@Injectable()
export class OrderRetryService {
  constructor(
    private readonly repo: OrderAdminRepository,
    private readonly effects: OrderAdminEffects,
    @Inject(OPERATOR_CHANNEL) private readonly channel: OperatorChannel,
  ) {}

  async retry(input: RetryInput): Promise<RetryOutcome> {
    assertOwnerChannel(this.channel);
    const orderId = checkedId('orderId', input.orderId);
    const reason = checkedReason(input.reason);
    const actor = checkedActor(input);
    let committed: { readonly auditId: string; readonly attemptsUsed: number } | null;
    try {
      committed = await retryOnDeadlock(() =>
        this.repo.transaction(async (tx) => {
          const order = await this.repo.lockOrder(tx, orderId);
          if (order === null) throw new AppError('NOT_FOUND');
          const last = await this.repo.lastEvent(orderId, tx);
          if (order.status !== 'HELD') {
            // Released by an earlier run (and not moved on since): nothing to write.
            if (order.status === 'QUEUED' && last?.note?.startsWith(OPERATOR_RELEASE_NOTE)) {
              return null;
            }
            throw validationError('order', 'NOT_HELD');
          }
          // Attempts are created only for a PROCESSING order, so under the order lock (status
          // HELD) none can be added while this transaction runs.
          const attempts = await this.repo.attemptErrors(tx, orderId);
          const before = {
            status: 'HELD',
            statusReason: order.statusReason,
            holdNote: last?.note ?? null,
            maxAttemptNo: maxAttemptNoOf(attempts),
          };
          const after = {
            status: 'QUEUED',
            operator: actor.operator,
            osUser: actor.osUser,
            actor: CLI_OWNER_AUDIT_ACTOR,
          };
          // The worker reads this row with the same schema (audit L-2): a row it could not read
          // is never written (the transaction rolls back, nothing is released).
          assertRetryAuditShape(before, after);
          const audit = await this.repo.createAudit(tx, {
            action: ORDER_RETRY_ACTION,
            targetId: orderId,
            before,
            after,
            reason,
            ip: actor.ip,
          });
          await this.repo.release(
            tx,
            orderId,
            actor.operator,
            `${OPERATOR_RELEASE_NOTE} ${audit.id}`,
          );
          return { auditId: audit.id, attemptsUsed: sendAttemptsUsed(attempts) };
        }),
      );
    } catch (error) {
      throw asRefusal(error);
    }
    const job = await this.effects.requeue(orderId);
    if (committed === null) {
      return {
        applied: false,
        orderId,
        auditId: null,
        job,
        adminAction: false,
        attemptsUsed: null,
      };
    }
    const adminAction = await this.effects.adminAction(committed.auditId);
    return {
      applied: true,
      orderId,
      auditId: committed.auditId,
      job,
      adminAction,
      attemptsUsed: committed.attemptsUsed,
    };
  }
}
