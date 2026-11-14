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
        await this.held(order);
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

  private async held(order: RunOrder): Promise<void> {
    const reason = order.statusReason ?? 'ADAPTER_ERROR';
    const event = await this.orders.latestHold(order.id);
    if (event !== null && isCoreHold(event.note)) {
      await this.notifier.send(holdNotices(order.id, event.eventId, reason));
      return;
    }
    const attempt = await this.attempts.latestAttemptHold(order.id);
    if (attempt === null) {
      this.logger.warn(`order ${order.id} is HELD by a hold the core cannot name: nothing re-sent`);
      return;
    }
    await this.notifier.send(holdNotices(order.id, attempt.id, reason));
  }
}
