import { Inject, Injectable, Logger } from '@nestjs/common';
import { ORDER_STALE_AFTER_MS, RECONCILE_BATCH_LIMIT, describeErrorForLog } from '@repo/shared';
import {
  ABANDON_PEEK,
  MAX_ABANDONED_REQUEUES,
  type AbandonPeek,
} from '../../fulfillment/abandon-counter';
import { FulfillEnqueuer, isLiveJobState } from '../../fulfillment/fulfill-enqueuer';
import { OrderLockUnavailableError } from '../../fulfillment/order-lock';
import { episodeRef } from './guard-ref';
import { OrderSweepsRepository, type SweepCursor } from './order-sweeps.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from './reconcile-order-lock';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// Step 3 of the tick (phase 5 S9d, D-64 (3), docs/06 safeguard 2, plan items 3/15/24): a PAID,
// QUEUED or PROCESSING order unchanged for ORDER_STALE_AFTER_MS (the tick's clock against the
// events' own: order-sweeps.repository.ts) whose fulfill-order job is not alive (an enqueue that
// failed after the purchase, a job stalled to death, an end-of-run re-check that failed, a last
// retry that met a held lease: fulfill-order.processor.ts) is queued again, ONLY through FulfillEnqueuer (a plain add
// would be dropped while a finished job holds the id). Nothing is paid here: the run that the job
// starts re-checks everything under the order lock, follows a live attempt and never pays it twice
// (PROCESSING included: the run, not the reconciler, writes TIMEOUT / NEEDS_REVIEW).
// - the decision is taken under `lock:order:{id}` (BUSY: a run holds it, left alone this tick); the
//   enqueue comes after the lease is gone, so the new job does not meet our own lease;
// - a live job (waiting, delayed, prioritized, active): left alone;
// - MAX_ABANDONED_REQUEUES final failures in the window (fulfill:abandoned:{id}): the settle
//   stopped that loop and the reconciler does not restart it; the owner gets
//   `<orderId>_abandoned_<day>` (guard-ref.ts): one message a day at most, so an order that stops
//   again after the 24 h count ran out (a new loop of failures) is heard again, never silent. The
//   count is read again right before the enqueue (a settle may have counted since the decision);
//   the reconciler only reads it (ABANDON_PEEK), the settle alone counts;
// - Redis cannot lock: the step stops (fail-closed); anything else: logged, the next order goes on.

type Decision = 'enqueue' | 'abandoned' | 'live' | 'moved';

@Injectable()
export class StaleOrdersStep implements ReconcileStep {
  readonly name = 'stale';
  private readonly logger = new Logger(StaleOrdersStep.name);
  private cursor: SweepCursor | null = null;

  constructor(
    private readonly repository: OrderSweepsRepository,
    private readonly enqueuer: FulfillEnqueuer,
    private readonly notifier: ReconcileNotifier,
    @Inject(ABANDON_PEEK) private readonly counter: AbandonPeek,
    @Inject(RECONCILE_ORDER_LOCK) private readonly lock: ReconcileOrderLock,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const before = new Date(context.nowMs - ORDER_STALE_AFTER_MS);
    const page = await this.repository.stalePage(before, this.cursor, RECONCILE_BATCH_LIMIT);
    this.cursor = page.length < RECONCILE_BATCH_LIMIT ? null : (page[page.length - 1] ?? null);
    for (const order of page) {
      try {
        const run = await this.lock.run(order.id, () => this.decide(order.id, before));
        if (run.busy) tally.add('busy');
        else await this.act(order.id, run.value, context.nowMs, tally);
      } catch (error) {
        if (error instanceof OrderLockUnavailableError) throw error;
        tally.add('failed');
        this.logger.error(
          `order ${order.id}: stale check failed: ${describeErrorForLog(error, 200)}`,
        );
      }
    }
    return tally.report();
  }

  /** Under the order lock: the state again, then the job, then the abandon count. */
  private async decide(orderId: string, before: Date): Promise<Decision> {
    if (!(await this.repository.isStale(orderId, before))) return 'moved';
    if (isLiveJobState(await this.enqueuer.stateOf(orderId))) return 'live';
    if ((await this.counter.peek(orderId)) >= MAX_ABANDONED_REQUEUES) return 'abandoned';
    return 'enqueue';
  }

  private async act(
    orderId: string,
    decision: Decision,
    nowMs: number,
    tally: StepTally,
  ): Promise<void> {
    switch (decision) {
      case 'enqueue': {
        // A job that failed for good since the decision was settled (and counted) meanwhile.
        if ((await this.counter.peek(orderId)) >= MAX_ABANDONED_REQUEUES) {
          return this.act(orderId, 'abandoned', nowMs, tally);
        }
        const action = await this.enqueuer.enqueue(orderId);
        if (action === 'keep') tally.add('kept');
        else tally.add('enqueued', orderId);
        return;
      }
      case 'abandoned': {
        const ref = episodeRef(orderId, 'abandoned', nowMs);
        if (ref === null) {
          this.logger.error(`order ${orderId}: re-queues used up, but no valid alert id: not sent`);
          tally.add('invalidRef');
          return;
        }
        this.logger.warn(`order ${orderId}: no job, its re-queues are used up: the owner decides`);
        await this.notifier.alert('needsReview', ref);
        tally.add('abandoned', orderId);
        return;
      }
      case 'live':
      case 'moved':
        tally.add(decision);
        return;
    }
  }
}
