import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DeliveryNotProvenError,
  LivePayoutError,
  PurchaseEntryMismatchError,
  PurchaseEntryMissingError,
  ReviewProofError,
  StaleOrderStateError,
} from '@repo/db';
import { RECONCILE_BATCH_LIMIT, describeErrorForLog, effectsOf } from '@repo/shared';
import { OrderLockUnavailableError } from '../../fulfillment/order-lock';
import { isGuardRefusal } from '../../ton/ton-db-errors';
import {
  TON_HOT_WALLET_ADDRESS,
  TON_TIMING,
  type TonHotWalletAddress,
  type TonTiming,
} from '../../ton/ton-tokens';
import { episodeRef } from './guard-ref';
import { OrderReconcileRepository, type ReviewCursor } from './order-reconcile.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from './reconcile-order-lock';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';
import {
  consumedTransferIds,
  decideReview,
  evidenceKey,
  type EvidenceContext,
} from './review-evidence';
import { EvidenceChangedError, ReviewResolver, type ReconcilerResolution } from './review-resolver';

// Step 2 of the tick (phase 5 S9, D-64 (2)): NEEDS_REVIEW orders, oldest first, a batch per tick
// (the walk goes on from where the last tick stopped and wraps around, so a backlog the owner has
// not answered cannot hide newer orders). Each order under its lock: the stored chain evidence
// decides (review-evidence.ts); a TON_TX or TON_NOT_SENT proof is resolved through
// `resolveNeedsReview` (review-resolver.ts), and only AFTER the commit the customer hears, the
// cached balance goes (refund) and the owner gets `reviewResolved` (`<orderId>_<auditId>`): the
// shared `effectsOf` plan with stable ids. Errors (plan §3 S9c):
// - StaleOrderStateError: another resolver won, a silent no-op;
// - ReviewProofError / LivePayoutError / DeliveryNotProvenError / EvidenceChangedError: nothing was
//   written, a warning with the code only, no alert (the order stays the owner's);
// - PurchaseEntryMissing / Mismatch: the money does not add up, `orderNoPurchase` (D-64 (6));
// - GG001: a DB guard refused, `reconcileGuardRefused` (one per order and hour), never retried;
// - Redis cannot lock: the step stops (fail-closed); anything else: logged, the next order goes on.

type Outcome = { readonly outcome: string; readonly decided: boolean };

@Injectable()
export class ReviewSweepStep implements ReconcileStep {
  readonly name = 'review';
  private readonly logger = new Logger(ReviewSweepStep.name);
  private cursor: ReviewCursor | null = null;

  constructor(
    private readonly repository: OrderReconcileRepository,
    private readonly resolver: ReviewResolver,
    private readonly notifier: ReconcileNotifier,
    @Inject(RECONCILE_ORDER_LOCK) private readonly lock: ReconcileOrderLock,
    @Inject(TON_HOT_WALLET_ADDRESS) private readonly wallet: TonHotWalletAddress,
    @Inject(TON_TIMING) private readonly timing: TonTiming,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const page = await this.repository.reviewPage(this.cursor, RECONCILE_BATCH_LIMIT);
    this.cursor = page.length < RECONCILE_BATCH_LIMIT ? null : (page[page.length - 1] ?? null);
    for (const order of page) {
      try {
        const run = await this.lock.run(order.id, () => this.reviewOne(order.id, context));
        if (run.busy) tally.add('busy');
        else tally.add(run.value.outcome, run.value.decided ? order.id : undefined);
      } catch (error) {
        if (error instanceof OrderLockUnavailableError) throw error;
        tally.add('failed');
        this.logger.error(`order ${order.id}: review failed: ${describeErrorForLog(error, 200)}`);
      }
    }
    return tally.report();
  }

  private evidenceContext(): EvidenceContext {
    return {
      network: this.wallet.network,
      walletAddress: this.wallet.rawAddress,
      expiryGapSec: this.timing.expiryGapSec,
    };
  }

  private async reviewOne(orderId: string, context: ReconcileContext): Promise<Outcome> {
    const attempts = await this.repository.payoutOf(orderId);
    const consumed = await this.remindConsumed(orderId, consumedTransferIds(attempts), context);
    const decision = decideReview(attempts, this.evidenceContext());
    switch (decision.kind) {
      case 'SKIP':
        return {
          outcome: consumed ? 'consumedUnmatched' : `skip:${decision.reason}`,
          decided: false,
        };
      case 'ALERT_CONSUMED':
        return { outcome: 'consumedUnmatched', decided: false };
      // I-5 (S9f): a transfer found on the chain late is the owner's; its alert, never a proof.
      case 'ALERT_LATE':
        await this.notifier.alert('tonLateConfirmed', decision.transferId);
        return { outcome: 'lateConfirmed', decided: false };
      case 'DELIVER':
        return this.resolve(orderId, { to: 'DELIVERED', proof: decision.proof }, attempts, context);
      case 'REFUND':
        return this.resolve(orderId, { to: 'FAILED', proof: decision.proof }, attempts, context);
    }
  }

  /**
   * Only the owner can say where a CONSUMED_UNMATCHED seqno's value went (TON_UNMATCHED_RESOLVED,
   * CLI): one reminder per transfer and hour of the database clock, whatever the decision (I-2).
   */
  private async remindConsumed(
    orderId: string,
    transferIds: readonly string[],
    context: ReconcileContext,
  ): Promise<boolean> {
    for (const transferId of transferIds) {
      const ref = episodeRef(transferId, 'cu', context.nowMs);
      if (ref === null)
        this.logger.error(`order ${orderId}: no alert id for transfer ${transferId}`);
      else await this.notifier.alert('tonConsumedUnmatched', ref);
    }
    return transferIds.length > 0;
  }

  private async resolve(
    orderId: string,
    resolution: ReconcilerResolution,
    attempts: Parameters<typeof evidenceKey>[0],
    context: ReconcileContext,
  ): Promise<Outcome> {
    const resolved = await this.resolver.resolve(orderId, resolution, evidenceKey(attempts)).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!resolved.ok) return this.refused(orderId, resolved.error, context);
    const { result, auditId } = resolved.value;
    const refunded = result.refund?.outcome === 'REFUNDED';
    this.logger.log(
      `order ${orderId}: NEEDS_REVIEW -> ${result.to} by the reconciler (${resolution.proof.kind}, audit ${auditId})`,
    );
    await this.notifier.run(
      effectsOf({
        kind: 'REVIEW_RESOLVED',
        orderId,
        auditId,
        userId: result.userId,
        delivered: result.to === 'DELIVERED',
        refunded,
        compromisedTransferId: null,
        byOperator: false,
      }),
    );
    return { outcome: result.to === 'DELIVERED' ? 'delivered' : 'refunded', decided: true };
  }

  private async refused(
    orderId: string,
    error: unknown,
    context: ReconcileContext,
  ): Promise<Outcome> {
    if (error instanceof OrderLockUnavailableError) throw error;
    if (error instanceof StaleOrderStateError) return { outcome: 'stale', decided: false };
    if (error instanceof ReviewProofError) {
      this.logger.warn(`order ${orderId}: the reconciler's proof was refused (${error.problem})`);
      return { outcome: 'refused', decided: false };
    }
    if (
      error instanceof LivePayoutError ||
      error instanceof DeliveryNotProvenError ||
      error instanceof EvidenceChangedError
    ) {
      this.logger.warn(`order ${orderId}: not resolved (${error.name})`);
      return { outcome: 'refused', decided: false };
    }
    if (error instanceof PurchaseEntryMissingError || error instanceof PurchaseEntryMismatchError) {
      this.logger.error(`order ${orderId}: the PURCHASE entry does not match (${error.name})`);
      await this.notifier.alert('orderNoPurchase', orderId);
      return { outcome: 'noPurchase', decided: false };
    }
    if (isGuardRefusal(error)) {
      this.logger.error(`order ${orderId}: a DB guard refused the resolution (GG001)`);
      const ref = episodeRef(orderId, 'review', context.nowMs);
      if (ref === null) this.logger.error(`order ${orderId}: no alert id for the guard refusal`);
      else await this.notifier.alert('reconcileGuardRefused', ref);
      return { outcome: 'guardRefused', decided: false };
    }
    this.logger.error(`order ${orderId}: resolution failed: ${describeErrorForLog(error, 200)}`);
    return { outcome: 'failed', decided: false };
  }
}
