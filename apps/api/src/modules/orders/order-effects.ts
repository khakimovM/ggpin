import { Injectable, Logger } from '@nestjs/common';
import { scrubSecretsInText } from '@repo/shared';
import { FulfillOrderEnqueuer } from '../../infra/queue/fulfill-order-enqueuer';
import { OrderNotifyProducer } from '../notifications/order-notify.producer';
import { WalletCache } from '../wallet/wallet-cache';

/**
 * How long one post-commit effect may hold the 201 (review M3): a Redis that is connected but does
 * not answer would otherwise keep the customer waiting, for an order that is already paid, until
 * the client gives up.
 */
export const EFFECT_TIMEOUT_MS = 2_500;

type Outcome = 'done' | 'timeout' | { readonly error: unknown };

/** What became of `work` within `ms`. Never rejects; a late rejection is still handled. */
function settleWithin(work: Promise<unknown>, ms: number): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, ms);
  });
  const settled = work.then(
    (): Outcome => 'done',
    (error: unknown): Outcome => ({ error }),
  );
  return Promise.race([settled, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * What follows a committed purchase (plan 6.1 step 3): the balance cache is dropped, the order is
 * queued for fulfillment (`jobId = orderId`, through the one enqueuer) and the customer is told it
 * was accepted. The money and the order are already committed, so none of these may turn the 201
 * into an error or hold it longer than EFFECT_TIMEOUT_MS: each runs on its own and a failure is
 * logged with the order id only (never the job data). An order left PAID without a job is the
 * reconciler's (docs/06 protection 2, phase 5 S9); a replay of the purchase (D-49) runs these again
 * while the order is still PAID, and both jobs are idempotent by their ids.
 */
@Injectable()
export class OrderEffects {
  private readonly logger = new Logger(OrderEffects.name);

  constructor(
    private readonly walletCache: WalletCache,
    private readonly fulfillment: FulfillOrderEnqueuer,
    private readonly notify: OrderNotifyProducer,
  ) {}

  async afterPurchase(userId: string, orderId: string): Promise<void> {
    const [cache, queued, notified] = await Promise.all([
      // Best effort by itself (its own Redis timeout; it logs and swallows its own failures).
      settleWithin(this.walletCache.invalidate(userId), EFFECT_TIMEOUT_MS),
      settleWithin(this.fulfillment.enqueue(orderId), EFFECT_TIMEOUT_MS),
      settleWithin(this.notify.enqueue('ORDER_ACCEPTED', orderId), EFFECT_TIMEOUT_MS),
    ]);
    if (cache === 'timeout')
      this.logger.warn(`balance cache for order ${orderId} not dropped (timeout)`);
    this.report('fulfill-order job', orderId, queued);
    this.report('ORDER_ACCEPTED notice', orderId, notified);
  }

  private report(what: string, orderId: string, outcome: Outcome): void {
    if (outcome === 'done') return;
    if (outcome === 'timeout') {
      // It may still land later; if it never does, the reconciler or a replay queues it again.
      this.logger.error(`${what} for order ${orderId} not queued (timeout)`);
      return;
    }
    // ioredis messages can quote the connection URL (password): scrubbed like every Redis error.
    const { error } = outcome;
    const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
    this.logger.error(`${what} for order ${orderId} not queued: ${reason}`);
  }
}
