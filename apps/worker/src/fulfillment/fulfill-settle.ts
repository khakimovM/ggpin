import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeErrorForLog } from '@repo/shared';
import type { TonNotice } from '../ton/ton-notices';
import { ABANDON_COUNTER, MAX_ABANDONED_REQUEUES, type AbandonCounter } from './abandon-counter';
import { AttemptsRepository } from './attempts.repository';
import { FulfillEnqueuer } from './fulfill-enqueuer';
import { FulfillReplay } from './fulfill-replay';
import { FulfillReviewer } from './fulfill-review';
import { isLiveAttempt } from './fulfill-steps';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { coreHoldNote, holdNotices } from './held-policy';
import { OrderStateRepository, type RunOrder } from './order-state.repository';

// An order whose fulfill-order job failed FOR GOOD (CR M1, audit M-1): the last attempt threw, or
// BullMQ failed the job without running it (stalled more than maxStalledCount: a crash loop). No
// job will run for it again, so it must not stay silent. Called under the order lock.
//
//   PROCESSING with a live attempt  -> NEEDS_REVIEW (ADAPTER_ERROR): the attempt may have been sent
//   PROCESSING without one          -> HELD (ADAPTER_ERROR), a core hold: nothing can have left
//   PAID / QUEUED                   -> enqueued again, at most MAX_ABANDONED_REQUEUES times in the
//                                      window (abandon-counter.ts); past that, the owner's alert.
//                                      Only from the failed event (requeue): inside the run the job
//                                      is still active, so an enqueue would be a no-op that counts
//   any other state                 -> its notices are sent again (the replay)
//   nothing can be written (DB)     -> at least the owner's `needsReview` alert for the order,
//                                      refId `<orderId>_abandoned`: the plain order id stays free
//                                      for the real NEEDS_REVIEW alert (notify ids dedupe for days)
//
// Never HELD when an attempt may be live, never FAILED or a refund: the outcome is unknown.

export type SettleOutcome =
  'MISSING' | 'REVIEW' | 'HELD' | 'REQUEUED' | 'DEFERRED' | 'REPLAYED' | 'ALERTED';

export interface SettleOptions {
  /**
   * PAID / QUEUED is enqueued again (and counted). False inside the failing run: the failed event
   * that follows settles it once (DEFERRED), so each failure counts once (S4 re-review R2).
   */
  readonly requeue: boolean;
}

@Injectable()
export class FulfillSettler {
  private readonly logger = new Logger(FulfillSettler.name);

  constructor(
    private readonly orders: OrderStateRepository,
    private readonly attempts: AttemptsRepository,
    private readonly reviewer: FulfillReviewer,
    private readonly replay: FulfillReplay,
    private readonly enqueuer: FulfillEnqueuer,
    private readonly notifier: FulfillmentNotifier,
    @Inject(ABANDON_COUNTER) private readonly counter: AbandonCounter,
  ) {}

  /** Never throws. */
  async settle(orderId: string, { requeue }: SettleOptions): Promise<SettleOutcome> {
    try {
      const order = await this.orders.load(orderId);
      if (order === null) return 'MISSING';
      switch (order.status) {
        case 'PROCESSING':
          return await this.processing(order);
        case 'PAID':
        case 'QUEUED':
          return requeue ? await this.requeue(orderId) : 'DEFERRED';
        default:
          await this.replay.replay(order);
          return 'REPLAYED';
      }
    } catch (error) {
      this.logger.error(
        `order ${orderId}: an abandoned run could not be settled: ${describeErrorForLog(error)}`,
      );
      return this.alertOnly(orderId);
    }
  }

  /** The owner hears about the order even when nothing could be read or written. */
  async alertOnly(orderId: string): Promise<'ALERTED'> {
    await this.notifier.send([needsReviewAlert(orderId)]);
    return 'ALERTED';
  }

  private async processing(order: RunOrder): Promise<SettleOutcome> {
    const live = (await this.attempts.list(order.id)).find((a) => isLiveAttempt(a.status));
    if (live !== undefined) {
      await this.reviewer.review(order.id, live.id, 'ADAPTER_ERROR', { abandoned: true });
      return 'REVIEW';
    }
    const reason = 'ADAPTER_ERROR';
    const eventId = await this.orders.hold(order.id, reason, coreHoldNote(reason, 'job failed'));
    if (eventId !== null) {
      this.logger.warn(`order ${order.id} held: its job failed for good before any attempt`);
      await this.notifier.send(holdNotices(order.id, eventId, reason));
    }
    return 'HELD';
  }

  private async requeue(orderId: string): Promise<SettleOutcome> {
    const count = await this.counter.bump(orderId);
    if (count > MAX_ABANDONED_REQUEUES) {
      this.logger.error(`order ${orderId}: its job failed for good ${String(count)} times`);
      return this.alertOnly(orderId);
    }
    const action = await this.enqueuer.enqueue(orderId);
    this.logger.warn(`order ${orderId}: its job failed for good, enqueue ${action}`);
    return 'REQUEUED';
  }
}

/** The refId of the owner's alert for an order that could not be settled (a composite ref). */
export function abandonedAlertRef(orderId: string): string {
  return `${orderId}_abandoned`;
}

function needsReviewAlert(orderId: string): TonNotice {
  return { kind: 'ALERT', alert: 'needsReview', refId: abandonedAlertRef(orderId) };
}
