import { Inject, Injectable, Logger } from '@nestjs/common';
import { RECONCILE_BATCH_LIMIT, describeErrorForLog } from '@repo/shared';
import { OrderLockUnavailableError } from '../../fulfillment/order-lock';
import { TonConfirmService } from '../../ton/ton-confirm.service';
import { isGuardRefusal } from '../../ton/ton-db-errors';
import { isUnresolved } from '../../ton/ton-payout';
import { TON_HOT_WALLET_ADDRESS, type TonHotWalletAddress } from '../../ton/ton-tokens';
import { episodeRef } from './guard-ref';
import { OrderReconcileRepository } from './order-reconcile.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from './reconcile-order-lock';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// Step 1 of the tick (phase 5 S9, plan §3 S9c): every ORDER transfer still SIGNED or BROADCAST on
// this worker's network and hot wallet gets one look at the chain, under its order's lock, through
// the TON module's own `TonConfirmService.check` (the reader, the classifier and the outcome writes
// of S5: nothing is decided here, and nothing is signed, broadcast or re-sent). A busy order (its
// fulfill run is waiting on that very transfer) is left to the run. A transfer of another wallet or
// network is not this worker's to read: logged and counted, never touched. A guard refusal
// (GG001) is the owner's (`reconcileGuardRefused`, one per order and hour) and is not retried in
// this tick; the next tick looks again (a check only reads, then writes what the chain proves).

@Injectable()
export class TransferSweepStep implements ReconcileStep {
  readonly name = 'transfers';
  private readonly logger = new Logger(TransferSweepStep.name);

  constructor(
    private readonly repository: OrderReconcileRepository,
    private readonly confirm: TonConfirmService,
    private readonly notifier: ReconcileNotifier,
    @Inject(RECONCILE_ORDER_LOCK) private readonly lock: ReconcileOrderLock,
    @Inject(TON_HOT_WALLET_ADDRESS) private readonly wallet: TonHotWalletAddress,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const transfers = await this.repository.pendingTransfers(this.wallet, RECONCILE_BATCH_LIMIT);
    const foreign = await this.repository.foreignPendingCount(this.wallet);
    if (foreign > 0) {
      // A count only: another wallet's address is not this worker's to log.
      tally.addMany('foreign', foreign);
      this.logger.warn(
        `${String(foreign)} unresolved ton transfer(s) of another wallet or network, not checked`,
      );
    }
    for (const transfer of transfers) {
      if (
        transfer.network !== this.wallet.network ||
        transfer.walletAddress !== this.wallet.rawAddress
      ) {
        // The query already leaves them out: a row here is a bug, counted and never touched.
        tally.add('foreign');
        this.logger.error(`ton transfer ${transfer.id}: another wallet or network in the batch`);
        continue;
      }
      if (transfer.orderId === null) {
        tally.add('orphan');
        this.logger.error(`ton transfer ${transfer.id}: an ORDER transfer without an order`);
        continue;
      }
      await this.checkOne(transfer.id, transfer.orderId, context, tally);
    }
    return tally.report();
  }

  private async checkOne(
    transferId: string,
    orderId: string,
    context: ReconcileContext,
    tally: StepTally,
  ): Promise<void> {
    try {
      const run = await this.lock.run(orderId, () => this.confirm.check(transferId));
      if (run.busy) {
        tally.add('busy');
        return;
      }
      if (isUnresolved(run.value.state.transferStatus)) tally.add('waiting');
      else tally.add(run.value.state.transferStatus.toLowerCase(), transferId);
    } catch (error) {
      // Redis cannot answer: no order can be locked this tick, the step stops (fail-closed).
      if (error instanceof OrderLockUnavailableError) throw error;
      if (isGuardRefusal(error)) {
        tally.add('guardRefused', orderId);
        await this.guardRefused(orderId, transferId, context);
        return;
      }
      tally.add('failed');
      this.logger.error(
        `ton transfer ${transferId} (order ${orderId}): check failed: ${describeErrorForLog(error, 200)}`,
      );
    }
  }

  private async guardRefused(
    orderId: string,
    transferId: string,
    context: ReconcileContext,
  ): Promise<void> {
    this.logger.error(`ton transfer ${transferId} (order ${orderId}): a DB guard refused (GG001)`);
    const ref = episodeRef(orderId, 'ton', context.nowMs);
    if (ref === null) {
      this.logger.error(`order ${orderId}: no alert id can be built for the guard refusal`);
      return;
    }
    await this.notifier.alert('reconcileGuardRefused', ref);
  }
}
