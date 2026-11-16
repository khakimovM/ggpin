import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  describeErrorForLog,
  effectsOf,
  notifyJobId,
  notifyJobSchema,
  type NotifyJob,
  type OrderEffectsPlan,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { FulfillOrderEnqueuer } from '../../../infra/queue/fulfill-order-enqueuer';
import { WalletCache } from '../../wallet/wallet-cache';

/** What an owner order action asks for after its transaction committed. */
export interface ResolvedEffects {
  readonly orderId: string;
  /** The order's owner; null when it could not be read (a replay): no wallet cache is deleted. */
  readonly userId: string | null;
  readonly to: 'DELIVERED' | 'FAILED';
  /** True when the resolution wrote the REFUND entry (FAILED): cache and customer notice. */
  readonly refunded: boolean;
  readonly auditId: string;
  /** `tonWalletCompromised`: the TonTransfer the alert names (S6 renderer refId). */
  readonly compromisedTransferId: string | null;
}

/** What `requeue` left in Redis: a job that will run, a job still running, or nothing. */
export type RequeueResult = 'QUEUED' | 'RUNNING' | 'FAILED';

/** Which job made it into Redis; `false` is told to the operator, the decision stands. */
export interface EffectsReport {
  readonly customerNotified: boolean;
  readonly adminAction: boolean;
  readonly reviewResolved: boolean;
  /** null when no security alert was due. */
  readonly securityAlert: boolean | null;
}

/**
 * The effects of the owner's order commands, AFTER the commit (a rolled-back decision tells
 * nobody anything). Every job has a stable id (the notify job id of its kind and refId), so a
 * re-run of the command after a crash queues each of them again without doubling any: the audit
 * row written in the transaction is the durable record they are derived from (I-3, see the
 * report). Best effort: a Redis failure is logged with ids only and reported as `false`.
 *
 * WHICH jobs, with which ids and in which order, is the shared `effectsOf` rule (phase 5 S9,
 * order-effects-plan.ts); the worker's audit-effects step rebuilds the same plan from the audit
 * row, so a restore after a crash between commit and queue repeats these exact ids.
 */
@Injectable()
export class OrderAdminEffects {
  private readonly logger = new Logger(OrderAdminEffects.name);

  constructor(
    private readonly cache: WalletCache,
    private readonly fulfillment: FulfillOrderEnqueuer,
    @InjectQueue(QUEUES.NOTIFY) private readonly queue: Queue,
  ) {}

  async afterResolve(e: ResolvedEffects): Promise<EffectsReport> {
    const plan = effectsOf({
      kind: 'REVIEW_RESOLVED',
      orderId: e.orderId,
      auditId: e.auditId,
      userId: e.userId,
      delivered: e.to === 'DELIVERED',
      refunded: e.refunded,
      compromisedTransferId: e.compromisedTransferId,
      byOperator: true,
    });
    const queued = await this.run(plan);
    const of = (match: (job: NotifyJob) => boolean): boolean | null => {
      const index = plan.notifyJobs.findIndex(match);
      return index === -1 ? null : (queued[index] ?? false);
    };
    const isAlert = (job: NotifyJob, alert: string): boolean =>
      job.kind === 'OWNER_ALERT' && job.alert === alert;
    return {
      customerNotified:
        of((job) => job.kind === 'ORDER_DELIVERED' || job.kind === 'ORDER_REFUNDED') ?? false,
      adminAction: of((job) => isAlert(job, 'adminAction')) ?? false,
      reviewResolved: of((job) => isAlert(job, 'reviewResolved')) ?? false,
      // The critical one goes before reviewResolved: the wallet is in someone else's hands (A3).
      securityAlert: of((job) => isAlert(job, 'tonWalletCompromised')),
    };
  }

  /**
   * A released HELD order goes back to fulfillment (the one enqueuer, jobId = orderId).
   * `RUNNING`: the enqueuer kept a job a worker is still running (the run that held the order, not
   * yet marked completed). That run will not look at the order again, so nothing will fulfil it:
   * the operator re-runs `order:retry` later (CR m4; FulfillOrderEnqueuer's doc).
   */
  async requeue(orderId: string): Promise<RequeueResult> {
    try {
      const done = await this.fulfillment.enqueue(orderId);
      if (done.action === 'keep' && (await done.job.getState()) === 'active') return 'RUNNING';
      return 'QUEUED';
    } catch (error) {
      this.logger.error(
        `fulfill-order for ${orderId} not queued: ${describeErrorForLog(error, 200)}`,
      );
      return 'FAILED';
    }
  }

  /** The owner's adminAction alert for any other audited action (fx:set, order:retry). */
  async adminAction(auditId: string): Promise<boolean> {
    const [queued = false] = await this.run(
      effectsOf({ kind: 'ADMIN_ACTION', auditId, byOperator: true }),
    );
    return queued;
  }

  /**
   * The cache first (a REFUND entry was written), then every job in the plan's order, one after
   * the other. Each job is validated right before its add (an id that cannot be a job id throws,
   * as before); a Redis failure only makes that job `false`. Requeue is not part of this run: it
   * has its own outcome (`requeue`).
   */
  private async run(plan: OrderEffectsPlan): Promise<boolean[]> {
    if (plan.invalidateWalletOf !== null) await this.cache.invalidate(plan.invalidateWalletOf);
    const queued: boolean[] = [];
    for (const job of plan.notifyJobs) {
      const valid = notifyJobSchema.parse(job);
      queued.push(await this.add(valid, describeJob(valid)));
    }
    return queued;
  }

  private async add(job: NotifyJob, what: string): Promise<boolean> {
    try {
      await this.queue.add(NOTIFY_JOB_NAME, job, { jobId: notifyJobId(job) });
      return true;
    } catch (error) {
      this.logger.error(`${what} not queued: ${describeErrorForLog(error, 200)}`);
      return false;
    }
  }
}

/** The log label of a job (ids only): `<alert> <refId>` or `<kind> <orderId>`, as before. */
function describeJob(job: NotifyJob): string {
  return job.kind === 'OWNER_ALERT' ? `${job.alert} ${job.refId}` : `${job.kind} ${job.refId}`;
}
