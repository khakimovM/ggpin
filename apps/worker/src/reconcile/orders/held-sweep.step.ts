import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LivePayoutError,
  PurchaseEntryMismatchError,
  PurchaseEntryMissingError,
  StaleOrderStateError,
} from '@repo/db';
import {
  RECONCILE_BATCH_LIMIT,
  REVIEW_NOTICE_RESEND_WINDOW_MS,
  describeErrorForLog,
  type OrderEffectsPlan,
} from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { FulfillEnqueuer } from '../../fulfillment/fulfill-enqueuer';
import { OrderLockUnavailableError } from '../../fulfillment/order-lock';
import { isGuardRefusal } from '../../ton/ton-db-errors';
import { HeldEvidence } from './held-evidence';
import { episodeAlert, episodeRef } from './guard-ref';
import { HeldPayoutError, type HeldPayout } from './held-payout';
import { releaseVerdict, triageHeld, type ReleasableReason } from './held-release-policy';
import { HeldSourcesRepository } from './held-sources.repository';
import { HeldWriter, HoldChangedError } from './held-writes';
import { OrderReconcileRepository } from './order-reconcile.repository';
import type { SweepCursor } from './order-sweeps.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from './reconcile-order-lock';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// The HELD step of the tick (phase 5 S9e, D-64 (4), plan items 4/25/32/34): HELD orders, oldest
// first, a batch per tick, each under `lock:order:{id}` (BUSY: a run or another step is on it).
// Under the lock the order is read again and the pure policy decides (held-release-policy.ts):
// - REFUND (HELD_MAX_AGE_MS since the latest hold): `failAndRefundOrder` in one transaction
//   (held-writes.ts); after the commit the cached balance goes, the customer gets ORDER_REFUNDED
//   and the owner `heldExpiredRefunded` (refId = the order, stable ids);
// - RELEASE (the cause is gone, at most HELD_AUTO_RELEASE_MAX times): HELD -> QUEUED, then, once
//   the lease is ours no more, the fulfill-order job through FulfillEnqueuer only (a lost enqueue
//   is the stale step's: QUEUED without a job);
// - NO_PURCHASE (the debit does not match): never refunded or released; `orderNoPurchase` is
//   queued again under the order's id (the run's own alert, deduped) and logged as an error;
// - PAYOUT (S9f M-1 / L-1): a late chain fact or a transfer that is not EXPIRED on the order: never
//   released, never refunded, whatever its age; the owner's `reconcileGuardRefused` (one per order
//   and hour). The writes check it again under the order's row lock (HeldPayoutError: rolled back);
// - KEEP: nothing.
// Errors: StaleOrderState / HoldChanged = someone moved first, a silent no-op; a live payout
// under a HELD order or a guard refusal (GG001) = `reconcileGuardRefused` (one per order and
// hour), never retried in this tick; Redis cannot lock = the step stops (fail-closed). A HELD
// order without any HELD event (its history was bypassed) is never acted on and is told to the
// owner the same way. The clock is read again from the database when the step starts: the tick's
// `nowMs` is minutes old after slow steps (never earlier than it: Math.max).
// A refund has no audit row for the S9h sweep to replay from: inside REVIEW_NOTICE_RESEND_WINDOW_MS
// its effects are queued again every tick under the same ids (BullMQ drops what is already there).

type Outcome =
  | { readonly kind: 'refunded'; readonly userId: string }
  | { readonly kind: 'released'; readonly reason: ReleasableReason }
  | { readonly kind: 'noPurchase' | 'noHeldEvent' }
  | { readonly kind: 'payout'; readonly why: Exclude<HeldPayout, 'clean'> }
  /** `livePayout`: the refund helper's own check; `dbGuard`: the database refused (GG001). */
  | { readonly kind: 'guard'; readonly by: 'livePayout' | 'dbGuard' }
  | { readonly kind: 'quiet'; readonly outcome: string };

/** The after-commit effects of a HELD_EXPIRED refund: stable ids, the wallet cache first. */
export function heldExpiredEffects(orderId: string, userId: string): OrderEffectsPlan {
  return {
    invalidateWalletOf: userId,
    notifyJobs: [
      { kind: 'ORDER_REFUNDED', refId: orderId },
      { kind: 'OWNER_ALERT', alert: 'heldExpiredRefunded', refId: orderId },
    ],
    requeueOrderId: null,
  };
}

@Injectable()
export class HeldSweepStep implements ReconcileStep {
  readonly name = 'held';
  private readonly logger = new Logger(HeldSweepStep.name);
  private cursor: SweepCursor | null = null;
  private refundCursor: SweepCursor | null = null;

  constructor(
    private readonly sources: HeldSourcesRepository,
    private readonly evidence: HeldEvidence,
    private readonly writer: HeldWriter,
    private readonly enqueuer: FulfillEnqueuer,
    private readonly notifier: ReconcileNotifier,
    @Inject(RECONCILE_ORDER_LOCK) private readonly lock: ReconcileOrderLock,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly clock: OrderReconcileRepository,
  ) {}

  async run(tick: ReconcileContext): Promise<StepReport> {
    const context = { ...tick, nowMs: Math.max(tick.nowMs, await this.clock.databaseNowMs()) };
    const tally = new StepTally(this.name);
    const page = await this.sources.heldPage(this.cursor, RECONCILE_BATCH_LIMIT);
    this.cursor = page.length < RECONCILE_BATCH_LIMIT ? null : (page[page.length - 1] ?? null);
    for (const order of page) {
      try {
        const run = await this.lock.run(order.id, () => this.decide(order.id, context));
        if (run.busy) tally.add('busy');
        else await this.after(order.id, run.value, tally, context);
      } catch (error) {
        if (error instanceof OrderLockUnavailableError) throw error;
        tally.add('failed');
        this.logger.error(
          `order ${order.id}: held check failed: ${describeErrorForLog(error, 200)}`,
        );
      }
    }
    await this.resendRefunds(context, tally);
    return tally.report();
  }

  /** Under the order lock: read again, decide, write. */
  private async decide(orderId: string, context: ReconcileContext): Promise<Outcome> {
    const look = await this.sources.heldOrder(orderId);
    if (look.kind === 'gone') return { kind: 'quiet', outcome: 'moved' };
    if (look.kind === 'noHeldEvent') return { kind: 'noHeldEvent' };
    const { order } = look;
    const triage = triageHeld(
      {
        reason: order.statusReason,
        heldAtMs: order.heldAt.getTime(),
        purchaseMatches: order.purchaseMatches,
        releasesUsed: order.releasesUsed,
        payout: order.payout,
      },
      context.nowMs,
      this.config.HELD_MAX_AGE_MS,
    );
    switch (triage.kind) {
      case 'NO_PURCHASE':
        return { kind: 'noPurchase' };
      case 'PAYOUT':
        return { kind: 'payout', why: triage.why };
      case 'KEEP':
        return { kind: 'quiet', outcome: `keep:${triage.why}` };
      case 'REFUND':
        return this.write(orderId, async () => {
          const outcome = await this.writer.refund(orderId, order.heldEvents);
          if (outcome.outcome !== 'REFUNDED') return { kind: 'quiet', outcome: 'stale' };
          return { kind: 'refunded', userId: outcome.userId };
        });
      case 'CHECK': {
        const evidence = await this.evidence.of(order, context.nowMs);
        if (evidence === null) return { kind: 'quiet', outcome: 'keep:notReleasable' };
        const verdict = releaseVerdict(triage.reason, evidence);
        if (!verdict.release) return { kind: 'quiet', outcome: `keep:${verdict.why}` };
        return this.write(orderId, async () => {
          await this.writer.release(orderId, triage.reason, order.heldEvents);
          return { kind: 'released', reason: triage.reason };
        });
      }
    }
  }

  /** A write, its refusals mapped to outcomes (nothing was written for any of them). */
  private async write(orderId: string, fn: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof StaleOrderStateError || error instanceof HoldChangedError) {
        return { kind: 'quiet', outcome: 'stale' };
      }
      if (error instanceof HeldPayoutError) return { kind: 'payout', why: error.why };
      if (
        error instanceof PurchaseEntryMissingError ||
        error instanceof PurchaseEntryMismatchError
      ) {
        return { kind: 'noPurchase' };
      }
      if (error instanceof LivePayoutError) {
        this.logger.error(`order ${orderId}: HELD with a live payout, not refunded`);
        return { kind: 'guard', by: 'livePayout' };
      }
      if (isGuardRefusal(error)) {
        this.logger.error(`order ${orderId}: a DB guard refused the held write (GG001)`);
        return { kind: 'guard', by: 'dbGuard' };
      }
      throw error;
    }
  }

  /** After the lease: effects, the enqueue, the owner's alerts. */
  private async after(
    orderId: string,
    outcome: Outcome,
    tally: StepTally,
    context: ReconcileContext,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'refunded':
        this.logger.warn(`order ${orderId}: HELD for HELD_MAX_AGE_MS -> FAILED + REFUND`);
        await this.notifier.run(heldExpiredEffects(orderId, outcome.userId));
        tally.add('refunded', orderId);
        return;
      case 'released':
        this.logger.log(`order ${orderId}: released by the reconciler (${outcome.reason})`);
        tally.add('released', orderId);
        try {
          await this.enqueuer.enqueue(orderId);
        } catch (error) {
          tally.add('enqueueFailed');
          this.logger.error(`order ${orderId}: not queued: ${describeErrorForLog(error, 200)}`);
        }
        return;
      case 'noPurchase':
        this.logger.error(
          `order ${orderId}: HELD without a matching PURCHASE debit, alerting again`,
        );
        await this.notifier.alert('orderNoPurchase', orderId);
        tally.add('noPurchase', orderId);
        return;
      case 'guard':
        await this.untouchable(orderId, context);
        tally.add('guardRefused', orderId);
        tally.add(`guard:${outcome.by}`);
        return;
      case 'payout':
        this.logger.error(
          `order ${orderId}: HELD beside a payout that may be out (${outcome.why})`,
        );
        // S9f (owner 2026-11-18): beside a late chain fact or a live transfer only the owner can
        // end it: once a day.
        await this.untouchable(
          orderId,
          context,
          outcome.why === 'lateFact' ? 'heldlate' : 'heldlive',
        );
        tally.add('payoutRefused', orderId);
        tally.add(`payout:${outcome.why}`);
        return;
      case 'noHeldEvent':
        this.logger.error(`order ${orderId}: HELD without a HELD event, not touched`);
        await this.untouchable(orderId, context);
        tally.add('noHeldEvent', orderId);
        return;
      case 'quiet':
        tally.add(outcome.outcome);
        return;
    }
  }

  /**
   * The owner's `reconcileGuardRefused`, once per order and hour (`<orderId>_held_<hour>`), or
   * per order and day beside a late chain fact (`<orderId>_heldlate_<day>`) or a transfer that is
   * not EXPIRED (`<orderId>_heldlive_<day>`, S9f).
   */
  private async untouchable(
    orderId: string,
    context: ReconcileContext,
    scope: 'held' | 'heldlate' | 'heldlive' = 'held',
  ): Promise<void> {
    const ref = episodeRef(orderId, scope, context.nowMs);
    if (ref === null) this.logger.error(`order ${orderId}: no alert id for the held refusal`);
    else await this.notifier.alert(episodeAlert(scope), ref);
  }

  private async resendRefunds(context: ReconcileContext, tally: StepTally): Promise<void> {
    const since = new Date(context.nowMs - REVIEW_NOTICE_RESEND_WINDOW_MS);
    const page = await this.sources.expiredRefundsSince(
      since,
      this.refundCursor,
      RECONCILE_BATCH_LIMIT,
    );
    this.refundCursor =
      page.length < RECONCILE_BATCH_LIMIT ? null : (page[page.length - 1] ?? null);
    for (const order of page) {
      const queued = await this.notifier.run(heldExpiredEffects(order.id, order.userId));
      tally.add(queued.every(Boolean) ? 'refundNoticed' : 'refundNoticeFailed');
    }
  }
}
