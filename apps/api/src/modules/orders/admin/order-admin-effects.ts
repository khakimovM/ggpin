import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  describeErrorForLog,
  notifyJobId,
  notifyJobSchema,
  type OrderNotifyKind,
  type OwnerAlertKind,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { FulfillOrderEnqueuer } from '../../../infra/queue/fulfill-order-enqueuer';
import { WalletCache } from '../../wallet/wallet-cache';

/** What an owner order action asks for after its transaction committed. */
export interface ResolvedEffects {
  readonly orderId: string;
  readonly userId: string;
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
    if (e.refunded) await this.cache.invalidate(e.userId);
    const kind: OrderNotifyKind = e.to === 'DELIVERED' ? 'ORDER_DELIVERED' : 'ORDER_REFUNDED';
    const customerNotified =
      e.to === 'DELIVERED' || e.refunded ? await this.notify(kind, e.orderId) : false;
    // The critical one first: the wallet is in someone else's hands (owner decision A3).
    const securityAlert =
      e.compromisedTransferId === null
        ? null
        : await this.alert('tonWalletCompromised', e.compromisedTransferId);
    const reviewResolved = await this.alert('reviewResolved', `${e.orderId}_${e.auditId}`);
    const adminAction = await this.alert('adminAction', e.auditId);
    return { customerNotified, adminAction, reviewResolved, securityAlert };
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

  /** The owner's adminAction alert for any other audited action (fx:set). */
  adminAction(auditId: string): Promise<boolean> {
    return this.alert('adminAction', auditId);
  }

  private async notify(kind: OrderNotifyKind, orderId: string): Promise<boolean> {
    return this.add(notifyJobSchema.parse({ kind, refId: orderId }), `${kind} ${orderId}`);
  }

  private async alert(alert: OwnerAlertKind, refId: string): Promise<boolean> {
    return this.add(
      notifyJobSchema.parse({ kind: 'OWNER_ALERT', alert, refId }),
      `${alert} ${refId}`,
    );
  }

  private async add(job: ReturnType<typeof notifyJobSchema.parse>, what: string): Promise<boolean> {
    try {
      await this.queue.add(NOTIFY_JOB_NAME, job, { jobId: notifyJobId(job) });
      return true;
    } catch (error) {
      this.logger.error(`${what} not queued: ${describeErrorForLog(error, 200)}`);
      return false;
    }
  }
}
