import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RECONCILE_BATCH_LIMIT,
  REVIEW_NOTICE_RESEND_WINDOW_MS,
  describeErrorForLog,
} from '@repo/shared';
import { FulfillReplay } from '../../fulfillment/fulfill-replay';
import { OrderLockUnavailableError } from '../../fulfillment/order-lock';
import { OrderSweepsRepository, type SweepCursor } from './order-sweeps.repository';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from './reconcile-order-lock';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// HELD and NEEDS_REVIEW notices sent again (phase 5 S9d, D-64 (3), Q-19, audit I-3): the run that
// held or reviewed the order queues its notices after its commit, best effort, and may die in
// between. Each tick re-adds them through FulfillReplay under the very same stable ids, so BullMQ
// drops what was already queued and nobody hears anything twice, ONLY while the order entered
// that state less than REVIEW_NOTICE_RESEND_WINDOW_MS ago (the tick's database clock against the
// event's own time, written by its process: order-sweeps.repository.ts): past the window a
// repeat could outlive the notify dedupe and reach the customer a second time. Under the order
// lock (BUSY: a run or another step is on it, next tick); the order is read again there and a
// moved one is left alone. Nothing is written but notify jobs. A HELD order whose hold cannot be
// named (UNNAMED, CR F5) sends nothing: counted `unnamed`, logged once per order (at most
// MAX_LOGGED remembered, this process only), not again every tick of its 24 hours.

/** Orders whose UNNAMED hold was logged; past this, a new one is still counted, not logged. */
export const MAX_LOGGED = 10_000;

@Injectable()
export class NoticeResendStep implements ReconcileStep {
  readonly name = 'noticeResend';
  private readonly logger = new Logger(NoticeResendStep.name);
  private cursor: SweepCursor | null = null;
  private readonly logged = new Set<string>();

  constructor(
    private readonly repository: OrderSweepsRepository,
    private readonly replay: FulfillReplay,
    @Inject(RECONCILE_ORDER_LOCK) private readonly lock: ReconcileOrderLock,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const since = new Date(context.nowMs - REVIEW_NOTICE_RESEND_WINDOW_MS);
    const page = await this.repository.noticePage(since, this.cursor, RECONCILE_BATCH_LIMIT);
    this.cursor = page.length < RECONCILE_BATCH_LIMIT ? null : (page[page.length - 1] ?? null);
    for (const order of page) {
      try {
        const run = await this.lock.run(order.id, () => this.replay.resendHeldOrReview(order.id));
        if (run.busy) tally.add('busy');
        else if (run.value === 'RESENT') tally.add('resent', order.id);
        else if (run.value === 'UNNAMED') this.unnamed(order.id, tally);
        else tally.add(run.value === 'MOVED' ? 'moved' : 'missing');
      } catch (error) {
        if (error instanceof OrderLockUnavailableError) throw error;
        tally.add('failed');
        this.logger.error(`order ${order.id}: resend failed: ${describeErrorForLog(error, 200)}`);
      }
    }
    return tally.report();
  }

  private unnamed(orderId: string, tally: StepTally): void {
    tally.add('unnamed', orderId);
    if (this.logged.has(orderId) || this.logged.size >= MAX_LOGGED) return;
    this.logged.add(orderId);
    this.logger.warn(`order ${orderId} is HELD by a hold the core cannot name: nothing re-sent`);
  }
}
