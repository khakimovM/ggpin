import { Injectable, Logger } from '@nestjs/common';
import { AttemptsRepository } from './attempts.repository';
import { FreshAttempt } from './fulfill-fresh';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { deliveredNotice, holdNotices, isCoreHold, reviewNotices } from './held-policy';
import { OrderStateRepository, type RunOrder } from './order-state.repository';

// The replay of a job whose order already left PROCESSING (a retried job, a stalled one that ran
// again, a duplicate enqueue). Nothing is paid; the notices of the order's final state are sent
// again under their stable ids (BullMQ drops a repeat), because the run that decided it may have
// died between its commit and its enqueue. A hold is never silent (rules/45).
// No replay calls pay() (CR m3): pay() takes the wallet lock before it can see the order is not
// PROCESSING, so a replay would turn another order's live payout into WALLET_BUSY. The TON
// module's hold notices are `heldNotices` (the same ids), and the core sends them itself.

@Injectable()
export class FulfillReplay {
  private readonly logger = new Logger(FulfillReplay.name);

  constructor(
    private readonly orders: OrderStateRepository,
    private readonly attempts: AttemptsRepository,
    private readonly fresh: FreshAttempt,
    private readonly notifier: FulfillmentNotifier,
  ) {}

  /** True when the state had something to replay. */
  async replay(order: RunOrder): Promise<boolean> {
    switch (order.status) {
      case 'HELD':
        if (!(await this.held(order))) {
          this.logger.warn(
            `order ${order.id} is HELD by a hold the core cannot name: nothing re-sent`,
          );
        }
        return true;
      case 'NEEDS_REVIEW':
        await this.notifier.send(reviewNotices(order.id));
        return true;
      case 'DELIVERED':
        await this.notifier.send([deliveredNotice(order.id)]);
        return true;
      case 'REFUNDED':
        // Only the refunds this core makes (a recipient gone or changed before anything left).
        if (order.statusReason !== 'RECIPIENT_CHANGED' && order.statusReason !== 'RECIPIENT_GONE') {
          return false;
        }
        await this.fresh.afterRefund(order.id, order.userId);
        return true;
      default:
        return false;
    }
  }

  /**
   * The order reconciler's resend (phase 5 S9d, D-64 (3)): the order as it is NOW, replayed only
   * while it is HELD or NEEDS_REVIEW (the stable ids make a repeat a no-op for BullMQ). Called
   * under the order lock; reads and queues notices, never writes the order. UNNAMED (S9d fix CR
   * F5): HELD by a hold the core cannot name (neither a core hold event nor an attempt hold), so
   * nothing was sent; the caller counts and logs it on its own (once), it is never `RESENT`.
   */
  async resendHeldOrReview(orderId: string): Promise<'MISSING' | 'MOVED' | 'RESENT' | 'UNNAMED'> {
    const order = await this.orders.load(orderId);
    if (order === null) return 'MISSING';
    if (order.status === 'HELD') return (await this.held(order)) ? 'RESENT' : 'UNNAMED';
    if (order.status !== 'NEEDS_REVIEW') return 'MOVED';
    await this.replay(order);
    return 'RESENT';
  }

  /** The hold's notices again; false when the hold cannot be named (nothing sent). */
  private async held(order: RunOrder): Promise<boolean> {
    const reason = order.statusReason ?? 'ADAPTER_ERROR';
    const event = await this.orders.latestHold(order.id);
    if (event !== null && isCoreHold(event.note)) {
      await this.notifier.send(holdNotices(order.id, event.eventId, reason));
      return true;
    }
    const attempt = await this.attempts.latestAttemptHold(order.id);
    if (attempt === null) return false;
    await this.notifier.send(holdNotices(order.id, attempt.id, reason));
    return true;
  }
}
