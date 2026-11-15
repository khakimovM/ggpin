import { Inject, Injectable } from '@nestjs/common';
import { attemptLimitReached } from '@repo/shared';
import { checkedId, checkedReason, validationError } from '../../../common/admin/admin-input';
import { AppError } from '../../../common/exceptions/app-error';
import { OrderAdminEffects, type RequeueResult } from './order-admin-effects';
import { asRefusal, retryOnDeadlock } from './order-admin-errors';
import { ORDER_RETRY_ACTION, OrderAdminRepository } from './order-admin.repository';
import {
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
}

/** The refusal of an order whose send attempts are used up (plan S10 fix round, item 1). */
export const ATTEMPT_LIMIT_NOT_SUPPORTED = 'ATTEMPT_LIMIT_NOT_SUPPORTED';

const OPERATOR_RELEASE_NOTE = 'operator retry';

/**
 * `order:retry` (phase 5 S10): HELD -> QUEUED by the owner, then fulfill-order through the one
 * enqueuer (jobId = orderId). The status is re-read under the order lock and the move is the state
 * machine's compare-and-set (`transitionOrder`); the AuditLog (ORDER_RETRY) is written in the same
 * transaction. No money moves here (the worker re-checks price, limits and the recipient before
 * any payout), so no owner code is asked. A re-run after the release only queues the job again
 * (idempotent by jobId).
 *
 * An order whose send attempts are used up (MAX_SEND_ATTEMPTS attempts proven not sent, counted
 * under the lock with the worker's own rule, never read from the HELD note) is REFUSED
 * (`ATTEMPT_LIMIT_NOT_SUPPORTED`): the worker would hold it again before any payout. It leaves HELD
 * by the refund once the hold ages out (plan Q5, HELD_MAX_AGE), which phase 5 S9 builds, or by an
 * operator release once the worker supports one (S9).
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
    let committed: { readonly auditId: string } | null;
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
          if (attemptLimitReached(await this.repo.attemptErrors(tx, orderId))) {
            throw validationError('order', ATTEMPT_LIMIT_NOT_SUPPORTED);
          }
          const audit = await this.repo.createAudit(tx, {
            action: ORDER_RETRY_ACTION,
            targetId: orderId,
            before: {
              status: 'HELD',
              statusReason: order.statusReason,
              holdNote: last?.note ?? null,
            },
            after: { status: 'QUEUED', operator: actor.operator, osUser: actor.osUser },
            reason,
            ip: actor.ip,
          });
          await this.repo.release(
            tx,
            orderId,
            actor.operator,
            `${OPERATOR_RELEASE_NOTE} ${audit.id}`,
          );
          return { auditId: audit.id };
        }),
      );
    } catch (error) {
      throw asRefusal(error);
    }
    const job = await this.effects.requeue(orderId);
    if (committed === null) {
      return { applied: false, orderId, auditId: null, job, adminAction: false };
    }
    const adminAction = await this.effects.adminAction(committed.auditId);
    return { applied: true, orderId, auditId: committed.auditId, job, adminAction };
  }
}
