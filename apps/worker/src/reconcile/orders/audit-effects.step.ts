import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_EFFECTS_MIN_AGE_MS,
  AUDIT_EFFECTS_WINDOW_MS,
  RECONCILE_BATCH_LIMIT,
  describeErrorForLog,
  orderEffectsPlan,
  type OrderEffectsPlan,
} from '@repo/shared';
import {
  ABANDON_PEEK,
  MAX_ABANDONED_REQUEUES,
  type AbandonPeek,
} from '../../fulfillment/abandon-counter';
import { FulfillEnqueuer, isLiveJobState } from '../../fulfillment/fulfill-enqueuer';
import { OrderLockUnavailableError } from '../../fulfillment/order-lock';
import {
  AuditEffectsRepository,
  type AuditCursor,
  type AuditEffectsRow,
} from './audit-effects.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from './reconcile-order-lock';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// The last step of the tick (phase 5 S9h, D-64 (9), audit I-3, plan item 29): the effects of an
// audited order action are queued by its writer AFTER its commit, best effort; a writer that dies
// in between (the API after `order:resolve` / `order:retry` / `fx:set` / `ton:hint`, or the
// reconciler after its own resolution, actorType SYSTEM) leaves the audit row as the only durable
// record. Each tick walks the rows created in [now - AUDIT_EFFECTS_WINDOW_MS, now -
// AUDIT_EFFECTS_MIN_AGE_MS] (the tick's database clock) and queues their effects again:
// - WHICH effects, with WHICH ids, is the shared `orderEffectsPlan` only (order-effects-plan.ts, the
//   rule the API's OrderAdminEffects and the review sweep use too): the same ids as the first run,
//   so BullMQ drops what is already queued (notifyJobId, 30-day dedupe) and nobody hears anything
//   twice; no id is made here. A refund's customer notice is ORDER_REFUNDED / <orderId>, the very
//   job the HELD sweep's HELD_EXPIRED refund queues (held-sweep.step.ts), so the two never double;
// - the cached balance is deleted first when the row wrote a REFUND entry (idempotent);
// - ORDER_RETRY of an order still QUEUED: back to fulfillment ONLY through FulfillEnqueuer
//   (jobId = orderId), decided under `lock:order:{id}` (BUSY: a run is on it; the cursor moves
//   past it, so it is seen again on the next lap, ~N/100 ticks for N rows in the window), never
//   while its job lives and never past the abandon count (the S9d stale step's rule: the settle
//   stopped that loop and the stale step tells the owner); the enqueue comes after the lease is gone;
// - the near edge leaves the writer time to queue them itself; the far edge keeps a replay well
//   inside the notify dedupe (the API's EFFECTS_REPLAY_MAX_AGE_MS is 29 days), so an old row never
//   reaches anyone a second time after its dedupe ran out.
// Nothing is written to the database here. Ids and counts only in the log.

type Requeue = 'enqueue' | 'live' | 'abandoned' | 'moved';

@Injectable()
export class AuditEffectsStep implements ReconcileStep {
  readonly name = 'auditEffects';
  private readonly logger = new Logger(AuditEffectsStep.name);
  private cursor: AuditCursor | null = null;

  constructor(
    private readonly repository: AuditEffectsRepository,
    private readonly notifier: ReconcileNotifier,
    private readonly enqueuer: FulfillEnqueuer,
    @Inject(ABANDON_PEEK) private readonly counter: AbandonPeek,
    @Inject(RECONCILE_ORDER_LOCK) private readonly lock: ReconcileOrderLock,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const since = new Date(context.nowMs - AUDIT_EFFECTS_WINDOW_MS);
    const until = new Date(context.nowMs - AUDIT_EFFECTS_MIN_AGE_MS);
    const page = await this.repository.page(since, until, this.cursor, RECONCILE_BATCH_LIMIT);
    const orders = await this.repository.ordersOf(
      page.filter((row) => row.targetType === 'Order').map((row) => row.targetId),
    );
    for (const row of page) {
      try {
        await this.restore(row, orderEffectsPlan(row, orders.get(row.targetId) ?? null), tally);
      } catch (error) {
        if (error instanceof OrderLockUnavailableError) throw error;
        tally.add('failed');
        this.logger.error(
          `audit ${row.id}: effects not restored: ${describeErrorForLog(error, 200)}`,
        );
      }
      // CR-1: the cursor moves past a row only once it is done (or logged as failed), so a step
      // that stops on a dead lock store resumes at that row next tick, not after a full lap.
      this.cursor = row;
    }
    // A short page is the end of the window: the next tick starts from its oldest row again.
    if (page.length < RECONCILE_BATCH_LIMIT) this.cursor = null;
    return tally.report();
  }

  private async restore(row: AuditEffectsRow, plan: OrderEffectsPlan, tally: StepTally) {
    const due =
      plan.notifyJobs.length > 0 ||
      plan.invalidateWalletOf !== null ||
      plan.requeueOrderId !== null;
    if (!due) {
      tally.add('nothing');
      return;
    }
    const queued = await this.notifier.run(plan);
    const lost = queued.filter((done) => !done).length;
    if (lost > 0) {
      tally.addMany('notQueued', lost);
      this.logger.warn(`audit ${row.id}: ${String(lost)} effect job(s) not queued, next lap`);
    }
    // CR-6: a row none of whose jobs went in was not replayed (notQueued says so, next lap).
    if (queued.length === 0 || lost < queued.length) tally.add('replayed');
    if (plan.requeueOrderId !== null) await this.requeue(plan.requeueOrderId, tally);
  }

  private async requeue(orderId: string, tally: StepTally): Promise<void> {
    const run = await this.lock.run(orderId, () => this.decide(orderId));
    if (run.busy) {
      tally.add('busy');
      return;
    }
    if (run.value !== 'enqueue') {
      tally.add(run.value);
      return;
    }
    // A job that failed for good since the decision was settled (and counted) meanwhile.
    if ((await this.counter.peek(orderId)) >= MAX_ABANDONED_REQUEUES) {
      tally.add('abandoned');
      return;
    }
    const action = await this.enqueuer.enqueue(orderId);
    if (action === 'keep') tally.add('kept');
    else tally.add('requeued', orderId);
  }

  /** Under the order lock: the status again, then the job, then the abandon count. */
  private async decide(orderId: string): Promise<Requeue> {
    if ((await this.repository.statusOf(orderId)) !== 'QUEUED') return 'moved';
    if (isLiveJobState(await this.enqueuer.stateOf(orderId))) return 'live';
    if ((await this.counter.peek(orderId)) >= MAX_ABANDONED_REQUEUES) return 'abandoned';
    return 'enqueue';
  }
}
