import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RefundOutcome } from '@repo/db';
import {
  ATTEMPT_LIMIT_HOLD_WHY,
  attemptLimitReached,
  coreHoldNote,
  describeErrorForLog,
  type OrderStatusReason,
} from '@repo/shared';
import {
  hasProviderRef,
  type AttemptJson,
  type FulfillmentAdapter,
  type PrepareContext,
  type PreparedFulfillment,
} from '../adapters/fulfillment-adapter';
import { parseProviderRef } from '../adapters/provider-ref';
import { WalletCacheInvalidator } from '../bank-feed/wallet-cache-invalidator';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { TON_PAY_ADDRESSES, type TonPayAddresses } from '../ton/ton-tokens';
import { AdapterRouter } from './adapter-router';
import { toAttemptJson } from './attempt-json';
import { AttemptsRepository, type AttemptRow } from './attempts.repository';
import { FulfillReviewer } from './fulfill-review';
import { FulfillSupplierRunner } from './fulfill-supplier.runner';
import { isLiveAttempt, isTonPaid, judgePrepared, purchaseAmountOf } from './fulfill-steps';
import { FulfillTonRunner, type RunStep } from './fulfill-ton.runner';
import { recipientRefund, type RecipientRefund } from './fulfill-eligibility';
import { FULFILL_HOOKS, type FulfillHooks } from './fulfill-tokens';
import { RECHECKED_REF_KEY, recipientFor } from './fulfill-recipient';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { holdNotices, noPurchaseNotice } from './held-policy';
import { OperatorReleaseRepository, clampRelease } from './operator-release.repository';
import { OrderStateRepository, type RunOrder } from './order-state.repository';

// A new attempt of a PROCESSING order that has no unresolved attempt (plan 6.6 steps 5-9). Up to
// the SENDING commit nothing has left, so every refusal is a HOLD (with the owner's alert) or, for
// a recipient that is gone or changed, FAILED + REFUND. A throw of the router or of `prepare` is
// retried by the queue; on the job's last attempt it holds the order (ADAPTER_ERROR, D-56 (4)).
// The route offers the order only to adapters of its cost currency (S7 review M1: a TON order
// with Fragment DOWN is HELD, NO_ADAPTER, before any provider is asked), then prefers the adapter
// that issued the recipient handle; another adapter checks the recipient again first
// (fulfill-recipient.ts, S7 CR #2), and only while the confirmation is fresh (STALE -> HELD).
// S9f (owner 2026-11-18): when an EARLIER attempt's payout may be out after all (a late chain
// fact), the database refuses both the hold and the refund (LivePayoutError): NEEDS_REVIEW instead.

type Decision =
  | { readonly kind: 'HOLD'; readonly reason: OrderStatusReason; readonly why: string }
  | RecipientRefund
  | {
      readonly kind: 'READY';
      readonly adapter: FulfillmentAdapter;
      readonly prepared: PreparedFulfillment;
      /** The context with the picked adapter's own recipient handle. */
      readonly context: PrepareContext;
      /** The attempt's `request`, with the re-checked handle when there was a re-check. */
      readonly request: AttemptJson;
    };

/** `providerRef`: the handle the adapter compares (default: the stored one). */
export function contextOf(
  order: RunOrder,
  attemptNo: number,
  providerRef: string | null = order.providerRef,
): PrepareContext {
  return {
    orderId: order.id,
    attemptNo,
    product: { id: order.productId, slug: order.productSlug },
    sku: { id: order.skuId, quantity: order.quantity },
    recipient: { fields: order.fields, providerRef },
  };
}

/** `request` plus the re-checked handle; null when `request` is not an object to carry it. */
function withRecheckedRef(request: AttemptJson, recheckedRef: string | null): AttemptJson | null {
  if (recheckedRef === null) return request;
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  return { ...request, [RECHECKED_REF_KEY]: recheckedRef };
}

@Injectable()
export class FreshAttempt {
  private readonly logger = new Logger(FreshAttempt.name);

  constructor(
    private readonly orders: OrderStateRepository,
    private readonly attempts: AttemptsRepository,
    private readonly releases: OperatorReleaseRepository,
    private readonly router: AdapterRouter,
    private readonly ton: FulfillTonRunner,
    private readonly supplier: FulfillSupplierRunner,
    private readonly notifier: FulfillmentNotifier,
    private readonly reviewer: FulfillReviewer,
    private readonly wallets: WalletCacheInvalidator,
    @Inject(FULFILL_HOOKS) private readonly hooks: FulfillHooks,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(TON_PAY_ADDRESSES) private readonly payAddresses: TonPayAddresses,
  ) {}

  async run(order: RunOrder, previous: readonly AttemptRow[], final: boolean): Promise<RunStep> {
    // The shared cap (S9b): attempts a hold failed before signing do not count, only payouts
    // PROVEN not sent do, and only those after the OWNER's latest release (null: all of them).
    if (attemptLimitReached(previous, await this.releasedAfter(order.id, previous))) {
      return this.hold(order.id, 'ADAPTER_ERROR', ATTEMPT_LIMIT_HOLD_WHY);
    }
    // S2 audit L2 / N2: no handle (null, empty, whitespace) -> never paid unchecked.
    if (!hasProviderRef({ fields: order.fields, providerRef: order.providerRef })) {
      return this.refund(order.id, recipientRefund('RECIPIENT_GONE'));
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
    if (decision.kind === 'REFUND') return this.refund(order.id, decision);
    const { adapter, prepared } = decision;
    const created = await this.attempts.createSending({
      orderId: order.id,
      attemptNo: context.attemptNo,
      adapter: adapter.code,
      request: toAttemptJson(decision.request),
      externalRef: isTonPaid(order.costCurrency) ? null : prepared.externalRef,
      costMinor: prepared.costMinor,
      purchaseTiyin: purchaseAmountOf(order),
    });
    if (created.kind === 'STALE') return this.afterStale(order.id);
    if (created.kind === 'NO_PURCHASE') {
      this.logger.error(`order ${order.id}: no matching PURCHASE debit, nothing is sent`);
      const step = await this.hold(order.id, 'ADAPTER_ERROR', 'no matching PURCHASE debit');
      // A money anomaly, not only a hold (D-64 (6)): its own critical alert, once per order.
      await this.notifier.send([noPurchaseNotice(order.id)]);
      return step;
    }
    await this.hooks.afterSendingCommitted(created.attempt.id);
    if (isTonPaid(order.costCurrency)) return this.ton.run(order.id, created.attempt, final);
    return this.supplier.run(decision.context, created.attempt, adapter, prepared);
  }

  /** The OWNER's latest release, if the order has attempts it could cover (fail-closed: null). */
  private async releasedAfter(
    orderId: string,
    previous: readonly AttemptRow[],
  ): Promise<number | null> {
    if (previous.length === 0) return null;
    return clampRelease(await this.releases.lastOwnerRelease(orderId), previous);
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
    const stored = order.providerRef ?? '';
    const issuer = parseProviderRef(stored)?.adapter ?? null;
    const adapter = await this.router.pick(
      order.productId,
      previousAdapter,
      issuer,
      order.costCurrency,
    );
    if (adapter === null) {
      return { kind: 'HOLD', reason: 'NO_ADAPTER', why: `no healthy ${order.costCurrency} route` };
    }
    const recipient = await recipientFor(adapter, context.product, {
      fields: order.fields,
      providerRef: stored,
      confirmedAt: order.createdAt,
    });
    if (recipient.kind === 'STALE') {
      this.logger.warn(`order ${order.id}: adapter ${adapter.code} re-check refused: too old`);
      return {
        kind: 'HOLD',
        reason: 'ADAPTER_ERROR',
        why: 'the recipient confirmation is too old for a name-only re-check',
      };
    }
    if (recipient.kind === 'CHANGED') {
      this.logger.warn(`order ${order.id}: adapter ${adapter.code} re-check: another recipient`);
      return recipientRefund('RECIPIENT_CHANGED');
    }
    if (recipient.kind === 'REFUSED') {
      this.logger.warn(`order ${order.id}: adapter ${adapter.code} re-check: recipient refused`);
      return recipientRefund('RECIPIENT_REFUSED');
    }
    const own = contextOf(order, context.attemptNo, recipient.providerRef);
    const result = await adapter.prepare(own);
    switch (result.status) {
      case 'RECIPIENT_CHANGED':
      case 'RECIPIENT_GONE':
      case 'RECIPIENT_REFUSED':
        return recipientRefund(result.status);
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
    const request = withRecheckedRef(result.prepared.request, recipient.recheckedRef);
    if (request === null) {
      return {
        kind: 'HOLD',
        reason: 'ADAPTER_ERROR',
        why: 'the request cannot carry the re-check',
      };
    }
    return { kind: 'READY', adapter, prepared: result.prepared, context: own, request };
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

  /** A refusal by LivePayoutError (S9f) goes to review instead (FulfillReviewer). */
  private async hold(orderId: string, reason: OrderStatusReason, why: string): Promise<RunStep> {
    let eventId: string | null;
    try {
      eventId = await this.orders.hold(orderId, reason, coreHoldNote(reason, why));
    } catch (error) {
      if (await this.reviewer.reviewIfPayoutLive(orderId, `hold ${reason}`, error)) return 'DONE';
      throw error;
    }
    if (eventId !== null) {
      this.logger.warn(`order ${orderId} held: ${reason} (${why})`);
      await this.notifier.send(holdNotices(orderId, eventId, reason));
    }
    return 'DONE';
  }

  private async refund(orderId: string, { reason, note }: RecipientRefund): Promise<RunStep> {
    let outcome: RefundOutcome | null;
    try {
      outcome = await this.orders.failAndRefund(orderId, reason, note);
    } catch (error) {
      if (await this.reviewer.reviewIfPayoutLive(orderId, `refund ${reason}`, error)) return 'DONE';
      throw error;
    }
    if (outcome?.outcome === 'REFUNDED') {
      // A fixed marker when the refund carries a note (SA L2): never the note or recipient data.
      const marker = note === null ? '' : ' (recipient refused)';
      this.logger.warn(`order ${orderId} failed and refunded: ${reason}${marker}`);
      await this.afterRefund(orderId, outcome.userId);
    }
    return 'DONE';
  }
}
