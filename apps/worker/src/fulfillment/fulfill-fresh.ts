import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeErrorForLog, type OrderStatusReason } from '@repo/shared';
import {
  hasProviderRef,
  type FulfillmentAdapter,
  type PrepareContext,
  type PreparedFulfillment,
} from '../adapters/fulfillment-adapter';
import { WalletCacheInvalidator } from '../bank-feed/wallet-cache-invalidator';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { TON_PAY_ADDRESSES, type TonPayAddresses } from '../ton/ton-tokens';
import { AdapterRouter } from './adapter-router';
import { toAttemptJson } from './attempt-json';
import { AttemptsRepository, type AttemptRow } from './attempts.repository';
import { FulfillSupplierRunner } from './fulfill-supplier.runner';
import {
  MAX_SEND_ATTEMPTS,
  isLiveAttempt,
  isTonPaid,
  judgePrepared,
  purchaseAmountOf,
} from './fulfill-steps';
import { FulfillTonRunner, type RunStep } from './fulfill-ton.runner';
import { FULFILL_HOOKS, type FulfillHooks } from './fulfill-tokens';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { coreHoldNote, holdNotices, isAttemptHoldError } from './held-policy';
import { OrderStateRepository, type RunOrder } from './order-state.repository';

// A new attempt of a PROCESSING order that has no unresolved attempt (plan 6.6 steps 5-9). Up to
// the SENDING commit nothing has left, so every refusal is a HOLD (with the owner's alert) or, for
// a recipient that is gone or changed, FAILED + REFUND. A throw of the router or of `prepare` is
// retried by the queue; on the job's last attempt it holds the order (ADAPTER_ERROR, D-56 (4)).

type Decision =
  | { readonly kind: 'HOLD'; readonly reason: OrderStatusReason; readonly why: string }
  | { readonly kind: 'REFUND'; readonly reason: 'RECIPIENT_CHANGED' | 'RECIPIENT_GONE' }
  | {
      readonly kind: 'READY';
      readonly adapter: FulfillmentAdapter;
      readonly prepared: PreparedFulfillment;
    };

export function contextOf(order: RunOrder, attemptNo: number): PrepareContext {
  return {
    orderId: order.id,
    attemptNo,
    product: { id: order.productId, slug: order.productSlug },
    sku: { id: order.skuId, quantity: order.quantity },
    recipient: { fields: order.fields, providerRef: order.providerRef },
  };
}

@Injectable()
export class FreshAttempt {
  private readonly logger = new Logger(FreshAttempt.name);

  constructor(
    private readonly orders: OrderStateRepository,
    private readonly attempts: AttemptsRepository,
    private readonly router: AdapterRouter,
    private readonly ton: FulfillTonRunner,
    private readonly supplier: FulfillSupplierRunner,
    private readonly notifier: FulfillmentNotifier,
    private readonly wallets: WalletCacheInvalidator,
    @Inject(FULFILL_HOOKS) private readonly hooks: FulfillHooks,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(TON_PAY_ADDRESSES) private readonly payAddresses: TonPayAddresses,
  ) {}

  async run(order: RunOrder, previous: readonly AttemptRow[], final: boolean): Promise<RunStep> {
    // Attempts a hold failed before signing do not count: only payouts PROVEN not sent do.
    if (previous.filter((a) => !isAttemptHoldError(a.error)).length >= MAX_SEND_ATTEMPTS) {
      return this.hold(order.id, 'ADAPTER_ERROR', 'every attempt was proven not sent');
    }
    // S2 audit L2 / N2: no handle (null, empty, whitespace) -> never paid unchecked.
    if (!hasProviderRef({ fields: order.fields, providerRef: order.providerRef })) {
      return this.refund(order.id, 'RECIPIENT_GONE');
    }
    const context = contextOf(order, (previous.at(-1)?.attemptNo ?? 0) + 1);
    let decision: Decision;
    try {
      decision = await this.decide(order, previous.at(-1)?.adapter ?? null, context);
    } catch (error) {
      if (!final) throw error;
      this.logger.error(
        `order ${order.id}: prepare failed on the last retry: ${describeErrorForLog(error)}`,
      );
      return this.hold(order.id, 'ADAPTER_ERROR', 'prepare failed through the last retry');
    }
    if (decision.kind === 'HOLD') return this.hold(order.id, decision.reason, decision.why);
    if (decision.kind === 'REFUND') return this.refund(order.id, decision.reason);
    const { adapter, prepared } = decision;
    const created = await this.attempts.createSending({
      orderId: order.id,
      attemptNo: context.attemptNo,
      adapter: adapter.code,
      request: toAttemptJson(prepared.request),
      externalRef: isTonPaid(order.costCurrency) ? null : prepared.externalRef,
      costMinor: prepared.costMinor,
      purchaseTiyin: purchaseAmountOf(order),
    });
    if (created.kind === 'STALE') return this.afterStale(order.id);
    if (created.kind === 'NO_PURCHASE') {
      this.logger.error(`order ${order.id}: no matching PURCHASE debit, nothing is sent`);
      return this.hold(order.id, 'ADAPTER_ERROR', 'no matching PURCHASE debit');
    }
    await this.hooks.afterSendingCommitted(created.attempt.id);
    if (isTonPaid(order.costCurrency)) return this.ton.run(order.id, created.attempt, final);
    return this.supplier.run(context, created.attempt, adapter, prepared);
  }

  /** Refunded after the commit: the cached balance goes, the customer hears (stable ids). */
  async afterRefund(orderId: string, userId: string): Promise<void> {
    try {
      await this.wallets.invalidate(userId);
    } catch (error) {
      this.logger.error(
        `order ${orderId}: wallet cache not invalidated: ${describeErrorForLog(error)}`,
      );
    }
    await this.notifier.refunded(orderId);
  }

  private async decide(
    order: RunOrder,
    previousAdapter: string | null,
    context: PrepareContext,
  ): Promise<Decision> {
    const adapter = await this.router.pick(order.productId, previousAdapter);
    if (adapter === null) return { kind: 'HOLD', reason: 'NO_ADAPTER', why: 'no healthy route' };
    const result = await adapter.prepare(context);
    switch (result.status) {
      case 'RECIPIENT_CHANGED':
      case 'RECIPIENT_GONE':
        return { kind: 'REFUND', reason: result.status };
      case 'REFUSED':
        this.logger.warn(`order ${order.id}: adapter ${adapter.code} refused to prepare`);
        return { kind: 'HOLD', reason: 'ADAPTER_ERROR', why: 'the provider refused' };
      case 'READY':
        break;
    }
    if (result.prepared.adapter !== adapter.code) {
      return { kind: 'HOLD', reason: 'ADAPTER_ERROR', why: 'prepared by another adapter' };
    }
    const verdict = judgePrepared(order, result.prepared, {
      supplierMaxPerOrderMicroUsdt: this.config.SUPPLIER_MAX_PER_ORDER_MICRO_USDT,
      payAddresses: this.payAddresses,
    });
    if (verdict.kind === 'HOLD') return verdict;
    return { kind: 'READY', adapter, prepared: result.prepared };
  }

  /**
   * The SENDING insert was refused by a unique key or a guard. Normally another run moved the order
   * or committed its own attempt first (its run owns it). Anything else (the supplier reference of
   * an earlier attempt, keyed by the order id, CLAUDE.md §5.4) would leave the order PROCESSING
   * with no attempt and nobody told: held instead.
   */
  private async afterStale(orderId: string): Promise<RunStep> {
    const status = await this.orders.statusOf(orderId);
    const live = (await this.attempts.list(orderId)).some((a) => isLiveAttempt(a.status));
    if (status !== 'PROCESSING' || live) {
      this.logger.warn(`order ${orderId}: another run moved the order first`);
      return 'DONE';
    }
    this.logger.error(`order ${orderId}: the SENDING row was refused and no run owns the order`);
    return this.hold(orderId, 'ADAPTER_ERROR', 'the attempt row was refused');
  }

  private async hold(orderId: string, reason: OrderStatusReason, why: string): Promise<RunStep> {
    const eventId = await this.orders.hold(orderId, reason, coreHoldNote(reason, why));
    if (eventId !== null) {
      this.logger.warn(`order ${orderId} held: ${reason} (${why})`);
      await this.notifier.send(holdNotices(orderId, eventId, reason));
    }
    return 'DONE';
  }

  private async refund(
    orderId: string,
    reason: 'RECIPIENT_CHANGED' | 'RECIPIENT_GONE',
  ): Promise<RunStep> {
    const outcome = await this.orders.failAndRefund(orderId, reason);
    if (outcome?.outcome === 'REFUNDED') {
      this.logger.warn(`order ${orderId} failed and refunded: ${reason}`);
      await this.afterRefund(orderId, outcome.userId);
    }
    return 'DONE';
  }
}
