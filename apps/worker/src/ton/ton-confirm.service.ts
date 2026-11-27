import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TonChainReader } from './ton-chain-reader';
import type { TonVerdict } from './ton-classifier';
import { errorKind } from './ton-db-errors';
import { tonNoticesFor } from './ton-notices';
import { TonNotifier } from './ton-notifier';
import { TonOutcomeRepository, type TonOutcome } from './ton-outcome.repository';
import { isSettled, isUnresolved, type PayoutState } from './ton-payout';
import { sameScanCursor } from './ton-scan-cursor';
import { TonScanCursorRepository } from './ton-scan-cursor.repository';
import { TON_TIMING, type TonTiming } from './ton-tokens';
import { TonTransferRepository, type StoredTransfer } from './ton-transfer.repository';
import type { ScanProgress } from './ton-tx-scan';

// The confirmation side (plan 6.4 step 6 - 6.5, docs/06): looks at the chain for an unresolved
// transfer, writes what is PROVEN (TonOutcomeRepository) and tells the customer and the owner
// (notices from the final rows). `awaitOutcome` polls until the transfer is decided or the order
// left PROCESSING, and after TON_CONFIRM_TIMEOUT_MS from the transfer's creation sends the order
// to NEEDS_REVIEW (CONFIRM_TIMEOUT). It never throws for a chain or database failure: after the
// SENDING commit an unknown outcome is a result, never an exception (rules/45 step 7). A message
// is never broadcast again from here (plan 6.5). An EXPIRY observation is handed to the outcome
// repository, which keeps the first and writes EXPIRED only on a second, later one (D-60 (2)).
// The scan's progress of an ORDER transfer is kept in the database between looks (phase 5 S9,
// L-2): a process that has not watched the transfer yet starts from it, and a look that moved it
// writes it back. Losing it only costs pages (the scan starts over), so a failure there is logged
// and the look goes on.

export interface TonCheck {
  /** null: the transfer was already decided before this look. */
  readonly verdict: TonVerdict | null;
  readonly state: PayoutState;
}

function outcomeOf(verdict: TonVerdict, timing: TonTiming): TonOutcome | null {
  switch (verdict.kind) {
    case 'CONFIRMED':
      return { kind: 'CONFIRMED', tx: verdict.tx };
    case 'BOUNCED':
      return { kind: 'BOUNCED', tx: verdict.tx, returnTx: verdict.returnTx };
    case 'EXPIRY_SEEN':
      return { kind: 'EXPIRY_SEEN', observation: verdict.observation, gapSec: timing.expiryGapSec };
    case 'CONSUMED_UNMATCHED':
      return { kind: 'CONSUMED_UNMATCHED', walletSeqno: verdict.walletSeqno };
    case 'SUSPECT':
      return { kind: 'SUSPECT', tx: verdict.tx, detail: verdict.detail };
    case 'WITNESS_CONFLICT':
      return { kind: 'WITNESS_CONFLICT', detail: verdict.detail, witness: verdict.witness };
    case 'WAIT':
      return null;
  }
}

@Injectable()
export class TonConfirmService {
  private readonly logger = new Logger(TonConfirmService.name);

  constructor(
    private readonly transfers: TonTransferRepository,
    private readonly outcomes: TonOutcomeRepository,
    private readonly reader: TonChainReader,
    private readonly notifier: TonNotifier,
    @Inject(TON_TIMING) private readonly timing: TonTiming,
    private readonly cursors: TonScanCursorRepository,
  ) {}

  /** One look at the chain; a decided verdict is written and announced. */
  async check(transferId: string): Promise<TonCheck> {
    const transfer = await this.transfers.findById(transferId);
    if (transfer === null) throw new Error(`TonTransfer ${transferId} does not exist`);
    if (!isUnresolved(transfer.status)) {
      this.reader.forget(transferId);
      const state = await this.outcomes.stateOf(transferId);
      await this.notifier.send(tonNoticesFor(state));
      return { verdict: null, state };
    }
    const before = await this.resumeScan(transfer);
    const verdict = await this.reader.examine(transfer, () => this.transfers.databaseNowMs());
    const outcome = outcomeOf(verdict, this.timing);
    if (outcome === null) {
      await this.keepScan(transfer, before);
      return { verdict, state: await this.outcomes.stateOf(transferId) };
    }
    const applied = await this.outcomes.apply(transferId, outcome);
    if (applied.applied) {
      this.logger.log(
        `ton transfer ${transferId}: ${verdict.kind} -> ${applied.state.transferStatus}`,
      );
    }
    if (!isUnresolved(applied.state.transferStatus)) this.reader.forget(transferId);
    else await this.keepScan(transfer, before);
    await this.notifier.send(tonNoticesFor(applied.state));
    return { verdict, state: applied.state };
  }

  /** The progress this look starts from: the kept cursor when this process has none yet. */
  private async resumeScan(transfer: StoredTransfer): Promise<ScanProgress | null> {
    if (transfer.attemptId !== null && !this.reader.isWatching(transfer.id)) {
      try {
        const kept = await this.cursors.load(transfer);
        if (kept !== null) this.reader.resumeScan(transfer.id, kept);
      } catch (error) {
        this.logger.warn(`ton transfer ${transfer.id}: scan cursor not read (${errorKind(error)})`);
      }
    }
    return this.reader.scanProgressOf(transfer.id);
  }

  /** Writes the scan's progress back when this look moved it (ORDER transfers only). */
  private async keepScan(transfer: StoredTransfer, before: ScanProgress | null): Promise<void> {
    if (transfer.attemptId === null) return;
    const after = this.reader.scanProgressOf(transfer.id);
    if (after === null || sameScanCursor(transfer, before, after)) return;
    try {
      await this.cursors.save(transfer, after);
    } catch (error) {
      this.logger.warn(`ton transfer ${transfer.id}: scan cursor not kept (${errorKind(error)})`);
    }
  }

  /**
   * Polls until the transfer is settled; the deadline is the transfer's creation (database clock)
   * plus TON_CONFIRM_TIMEOUT_MS. Whatever happens, the wait ends after twice that time on our own
   * clock (review n4: a database that cannot even be read must not hold the job and the wallet
   * lease for ever). Null only when the database could not be read at the end.
   */
  async awaitOutcome(
    transferId: string,
    keepAlive: () => Promise<unknown> = () => Promise.resolve(),
  ): Promise<PayoutState | null> {
    const hardStop = Date.now() + 2 * this.timing.confirmTimeoutMs;
    let deadline: number | null = null;
    for (;;) {
      try {
        if (deadline === null) deadline = await this.deadlineOf(transferId);
        const { state } = await this.check(transferId);
        if (isSettled(state)) return state;
      } catch (error) {
        this.logger.error(`ton transfer ${transferId}: check failed (${errorKind(error)})`);
      }
      const now = Date.now();
      const end = deadline === null ? hardStop : Math.min(deadline, hardStop);
      if (now >= end) return this.timeout(transferId);
      await keepAlive();
      await sleep(Math.max(1, Math.min(this.timing.pollMs, end - now)));
    }
  }

  /**
   * `createdAt` is the database's clock, so the time left is measured on that clock and then
   * counted down on ours: a database host whose clock is off (or a VM clock that is stepped back)
   * neither sends every payout to review at once nor stretches the wait.
   */
  private async deadlineOf(transferId: string): Promise<number> {
    const transfer = await this.transfers.findById(transferId);
    if (transfer === null) throw new Error(`TonTransfer ${transferId} does not exist`);
    const databaseNow = await this.transfers.databaseNowMs();
    const leftMs = transfer.createdAt.getTime() + this.timing.confirmTimeoutMs - databaseNow;
    return Date.now() + leftMs;
  }

  /** No proof in time: the order goes to NEEDS_REVIEW; the transfer stays for the reconciler. */
  private async timeout(transferId: string): Promise<PayoutState | null> {
    try {
      const applied = await this.outcomes.apply(transferId, { kind: 'TIMEOUT' });
      if (applied.applied) this.logger.warn(`ton transfer ${transferId}: no proof in time, review`);
      await this.notifier.send(tonNoticesFor(applied.state));
      return applied.state;
    } catch (error) {
      this.logger.error(`ton transfer ${transferId}: timeout not recorded (${errorKind(error)})`);
      try {
        return await this.outcomes.stateOf(transferId);
      } catch {
        return null;
      }
    }
  }
}
