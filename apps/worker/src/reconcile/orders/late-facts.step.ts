import { Inject, Injectable, Logger } from '@nestjs/common';
import { RECONCILE_BATCH_LIMIT, describeErrorForLog } from '@repo/shared';
import { OrderLockUnavailableError } from '../../fulfillment/order-lock';
import { foreignRef } from '../../ton/ton-late-hint';
import { otherTransferLateNotices } from '../../ton/ton-notices';
import { TonLateService, type LateCheck } from '../../ton/ton-late.service';
import { TON_HOT_WALLET_ADDRESS, type TonHotWalletAddress } from '../../ton/ton-tokens';
import { episodeRef } from './guard-ref';
import {
  LateFactsRepository,
  type LateCursor,
  type LateItem,
  type LatePage,
} from './late-facts.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from './reconcile-order-lock';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// Step 8 of the tick (phase 5 S9f, D-64 (7)): the late chain facts of the worker's own hot wallet.
// Four short lists, each walked by its own keyset cursor that wraps around, together at most
// RECONCILE_BATCH_LIMIT transfers a tick: (1) SUSPECT transfers whose transaction sent nothing
// (ONCHAIN_FAILED, needs every witness), (2) owner hints for CONSUMED_UNMATCHED transfers (Z6),
// (3) EXPIRED / CONSUMED_UNMATCHED transfers found on the chain after all (72 h), (4) CONFIRMED
// transfers whose destination bounced later (72 h). Each transfer is looked at under its order's
// lock, through TonLateService (the TON module reads the chain and writes the fact; this step
// never reads the chain, never moves money, never closes an order). A refused write (GG001, or a
// live transfer holding the seqno) is the owner's `reconcileGuardRefused`, one per order and hour,
// never silent. A recorded `late` / `lateBounce` fact re-queues its alert under the same job id,
// so a lost enqueue after the commit is made good by the next tick. A `lateDestination` fact (the
// destination aborted, or the transaction did not pay: owner 2026-11-18) is heard on the existing
// `reconcileGuardRefused` episode (`<orderId>_ton_<hour>`), at most hourly while the transfer is
// inside the watch window, from the database fact (no in-memory "settled" can silence it). A hint
// kept as FOREIGN_MESSAGE re-queues its `tonSeqnoUnmatched` (foreignRef) on every lap of the hint
// walk, from that fact too (S9i, S9f SA N-2): one lost enqueue at the decision is made good. So
// does an OTHER_TRANSFER mark of a settled order (`tonLateConfirmed` <T1>_<auditId>, S9i R1), both
// only while the decided hint is inside the notify dedupe window (R2, late-hint-repeats.ts).

/** Each list's share of the tick's batch. */
const PAGE = Math.floor(RECONCILE_BATCH_LIMIT / 4);

type Walk = 'failed' | 'hints' | 'notSent' | 'confirmed';

@Injectable()
export class LateFactsStep implements ReconcileStep {
  readonly name = 'late';
  private readonly logger = new Logger(LateFactsStep.name);
  private readonly cursors: Record<Walk, LateCursor | null> = {
    failed: null,
    hints: null,
    notSent: null,
    confirmed: null,
  };

  constructor(
    private readonly repository: LateFactsRepository,
    private readonly late: TonLateService,
    private readonly notifier: ReconcileNotifier,
    @Inject(RECONCILE_ORDER_LOCK) private readonly lock: ReconcileOrderLock,
    @Inject(TON_HOT_WALLET_ADDRESS) private readonly wallet: TonHotWalletAddress,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const scope = { network: this.wallet.network, rawAddress: this.wallet.rawAddress };
    const failed = this.advance(
      'failed',
      await this.repository.failedSuspectPage(scope, this.cursors.failed, PAGE),
    );
    for (const item of failed) {
      await this.one(item, tally, context, () => this.late.onchainFailed(item.transferId));
    }
    const hintPage = await this.repository.hintPage(scope, context.nowMs, this.cursors.hints, PAGE);
    for (const item of hintPage.foreign) {
      await this.notifier.alert('tonSeqnoUnmatched', foreignRef(item.transferId));
    }
    for (const mark of hintPage.otherLate) {
      for (const notice of otherTransferLateNotices(
        mark.orderStatus,
        mark.transferId,
        mark.auditId,
      )) {
        if (notice.kind === 'ALERT') await this.notifier.alert(notice.alert, notice.refId);
      }
    }
    const hints = this.advance('hints', hintPage);
    for (const item of hints) {
      await this.one(item, tally, context, () => this.late.checkHint(item.transferId, item.hint));
    }
    const notSent = this.advance(
      'notSent',
      await this.repository.notSentPage(scope, context.nowMs, this.cursors.notSent, PAGE),
    );
    for (const item of notSent) {
      await this.one(item, tally, context, () => this.late.lateConfirm(item.transferId));
    }
    const confirmed = this.advance(
      'confirmed',
      await this.repository.confirmedPage(scope, context.nowMs, this.cursors.confirmed, PAGE),
    );
    for (const item of confirmed) {
      if (item.late) await this.notifier.alert('tonLateConfirmed', item.transferId);
      if (item.lateBounce) await this.notifier.alert('tonBounced', item.transferId);
      if (item.lateDestination) await this.episodeAlert(item.orderId, context);
      if (item.lateBounce || item.lateDestination) continue;
      await this.one(item, tally, context, () => this.late.lateBounce(item.transferId));
    }
    return tally.report();
  }

  /** The order's hourly `reconcileGuardRefused` episode (guard-ref.ts, scope `ton`). */
  private async episodeAlert(orderId: string, context: ReconcileContext): Promise<void> {
    const ref = episodeRef(orderId, 'ton', context.nowMs);
    if (ref === null) this.logger.error(`order ${orderId}: no alert id for the late fact`);
    else await this.notifier.alert('reconcileGuardRefused', ref);
  }

  private advance<T>(walk: Walk, page: LatePage<T>): readonly T[] {
    this.cursors[walk] = page.next;
    return page.items;
  }

  private async one(
    item: LateItem,
    tally: StepTally,
    context: ReconcileContext,
    look: () => Promise<LateCheck>,
  ): Promise<void> {
    try {
      const run = await this.lock.run(item.orderId, look);
      if (run.busy) {
        tally.add('busy');
        return;
      }
      await this.count(item, run.value, tally, context);
    } catch (error) {
      if (error instanceof OrderLockUnavailableError) throw error;
      tally.add('failed');
      this.logger.error(
        `transfer ${item.transferId}: late look failed: ${describeErrorForLog(error, 200)}`,
      );
    }
  }

  private async count(
    item: LateItem,
    result: LateCheck,
    tally: StepTally,
    context: ReconcileContext,
  ): Promise<void> {
    switch (result.kind) {
      case 'WRITTEN':
        tally.add(result.what, item.orderId);
        if (result.what === 'LATE_DESTINATION') await this.episodeAlert(item.orderId, context);
        return;
      case 'NOTHING':
        tally.add(`nothing:${result.why}`);
        return;
      case 'WAIT':
        tally.add(`wait:${result.why}`);
        return;
      case 'REFUSED':
        tally.add('guardRefused');
        await this.episodeAlert(result.orderId ?? item.orderId, context);
    }
  }
}
