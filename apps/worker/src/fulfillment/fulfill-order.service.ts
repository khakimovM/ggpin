import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeErrorForLog, type OrderStatus } from '@repo/shared';
import type { LockStore } from '../bank-feed/client/leader-lock';
import { AdapterRouter } from './adapter-router';
import { AttemptsRepository, type AttemptRow } from './attempts.repository';
import { FreshAttempt, contextOf } from './fulfill-fresh';
import { FulfillReplay } from './fulfill-replay';
import { FulfillReviewer } from './fulfill-review';
import { FulfillSettler, type SettleOutcome } from './fulfill-settle';
import { MAX_SEND_ATTEMPTS, RetryLaterError, isLiveAttempt, isTonPaid } from './fulfill-steps';
import { FulfillSupplierRunner } from './fulfill-supplier.runner';
import { FulfillTonRunner, type RunStep } from './fulfill-ton.runner';
import { FULFILL_TIMING, ORDER_LOCK_STORE, type FulfillTiming } from './fulfill-tokens';
import { OrderLock } from './order-lock';
import { OrderStateRepository, type RunOrder } from './order-state.repository';

// One run of a fulfill-order job (rules/45 "Every attempt", plan 6.6):
//  1. `lock:order:{id}` (cooperative; the database is the fence);
//  2. re-read the order: PAID -> QUEUED -> PROCESSING (compare-and-set moves); any other state is
//     a replay: its notices are re-sent, nothing is paid;
//  3. an unresolved attempt (SENDING / SENT / UNKNOWN) is only FOLLOWED, never paid again;
//  4. otherwise a fresh attempt (fulfill-fresh.ts): route, re-check the recipient, prepare, the
//     ceiling and the supplier limit, the PURCHASE debit, SENDING commit, then the payout;
//  5. a payout PROVEN not sent may be followed by one more attempt (MAX_SEND_ATTEMPTS).
// A throw before SENDING is retried by the queue; after SENDING nothing throws for "unknown" on the
// job's last attempt (it is NEEDS_REVIEW). A throw on the last attempt anyway (a database error, a
// lost commit answer, a payout guard) is settled before the lease goes (fulfill-settle.ts), and so
// is a job BullMQ failed for good without running it (settleAbandoned, from the processor). The
// end-of-run re-read (safeguard 1) is the processor's, after BullMQ marked the job finished.

export type RunOutcome = 'MISSING' | 'BUSY' | 'NOOP' | 'REPLAYED' | 'DONE';

export interface RunOptions {
  /** The job's last attempt: what would be retried is decided instead (HELD / NEEDS_REVIEW). */
  readonly finalAttempt: boolean;
}

@Injectable()
export class FulfillOrderService {
  private readonly logger = new Logger(FulfillOrderService.name);
  private readonly lock: OrderLock;

  constructor(
    private readonly orders: OrderStateRepository,
    private readonly attempts: AttemptsRepository,
    private readonly router: AdapterRouter,
    private readonly fresh: FreshAttempt,
    private readonly replay: FulfillReplay,
    private readonly ton: FulfillTonRunner,
    private readonly supplier: FulfillSupplierRunner,
    private readonly reviewer: FulfillReviewer,
    private readonly settler: FulfillSettler,
    @Inject(ORDER_LOCK_STORE) store: LockStore,
    @Inject(FULFILL_TIMING) timing: FulfillTiming,
  ) {
    this.lock = new OrderLock(store, timing.orderLockTtlMs);
  }

  async run(orderId: string, options: RunOptions): Promise<RunOutcome> {
    const locked = await this.lock.run(orderId, () =>
      this.runOrSettle(orderId, options.finalAttempt),
    );
    if (!locked.busy) return locked.value;
    // Another run holds the order; this job only needs to exist while that one finishes.
    if (!options.finalAttempt) throw new RetryLaterError('another run holds the order');
    this.logger.warn(`order ${orderId}: still held by another run on the last retry`);
    return 'BUSY';
  }

  statusOf(orderId: string): Promise<OrderStatus | null> {
    return this.orders.statusOf(orderId);
  }

  /**
   * The order's job failed for good (CR M1): settled under the order lock. Never throws. BUSY:
   * another run holds the order and decides it; ALERTED: Redis could not even give the lock.
   */
  async settleAbandoned(orderId: string): Promise<SettleOutcome | 'BUSY'> {
    try {
      const locked = await this.lock.run(orderId, () =>
        this.settler.settle(orderId, { requeue: true }),
      );
      if (!locked.busy) return locked.value;
      this.logger.warn(`order ${orderId}: its job failed for good while another run holds it`);
      return 'BUSY';
    } catch (error) {
      this.logger.error(`order ${orderId}: not settled: ${describeErrorForLog(error)}`);
      return this.settler.alertOnly(orderId);
    }
  }

  private async runOrSettle(orderId: string, final: boolean): Promise<RunOutcome> {
    try {
      return await this.runLocked(orderId, final);
    } catch (error) {
      if (!final) throw error;
      // No retry follows: decided now, still under the lease. The job still fails (visible).
      this.logger.error(`order ${orderId}: the last retry threw: ${describeErrorForLog(error)}`);
      // PAID / QUEUED is left to the failed event (DEFERRED): the job is still active here.
      await this.settler.settle(orderId, { requeue: false });
      throw error;
    }
  }

  private async runLocked(orderId: string, final: boolean): Promise<RunOutcome> {
    let order = await this.orders.load(orderId);
    if (order?.status === 'PAID') {
      await this.orders.advance(orderId, 'PAID');
      order = await this.orders.load(orderId);
    }
    if (order?.status === 'QUEUED') {
      await this.orders.advance(orderId, 'QUEUED');
      order = await this.orders.load(orderId);
    }
    if (order === null) {
      this.logger.error(`fulfill-order: order ${orderId} does not exist`);
      return 'MISSING';
    }
    if (order.status !== 'PROCESSING') {
      return (await this.replay.replay(order)) ? 'REPLAYED' : 'NOOP';
    }
    await this.drive(order, final);
    return 'DONE';
  }

  private async drive(order: RunOrder, final: boolean): Promise<void> {
    // Each round ends an attempt; fresh() holds the order once MAX_SEND_ATTEMPTS were used.
    for (let round = 0; round <= MAX_SEND_ATTEMPTS; round += 1) {
      const attempts = await this.attempts.list(order.id);
      const live = attempts.find((a) => isLiveAttempt(a.status));
      const step =
        live === undefined
          ? await this.fresh.run(order, attempts, final)
          : await this.resume(order, live, final);
      if (step === 'DONE') return;
    }
    throw new Error(`fulfill-order: order ${order.id} did not settle within the attempt cap`);
  }

  /** rules/45 step 2: an attempt that may have been sent is followed, never paid again. */
  private async resume(order: RunOrder, live: AttemptRow, final: boolean): Promise<RunStep> {
    if (live.status === 'UNKNOWN') {
      // Written together with NEEDS_REVIEW everywhere, so an order still PROCESSING here was left
      // half-done by hand: the outcome is unknown, a human decides.
      await this.reviewer.review(order.id, live.id, 'ADAPTER_ERROR');
      return 'DONE';
    }
    if (isTonPaid(order.costCurrency)) return this.ton.run(order.id, live, final);
    const adapter = this.router.adapterOf(live.adapter);
    return this.supplier.run(contextOf(order, live.attemptNo), live, adapter, null);
  }
}
