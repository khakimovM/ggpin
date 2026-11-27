import { Inject, Injectable, Logger } from '@nestjs/common';
import { RECONCILE_BATCH_LIMIT } from '@repo/shared';
import {
  TON_HOT_WALLET_ADDRESS,
  TON_TIMING,
  type TonHotWalletAddress,
  type TonTiming,
} from '../../ton/ton-tokens';
import { WALLET_BLOCKED_REMIND_EVERY_MS, episodeAlert, walletBlockedRef } from './guard-ref';
import { HeldSourcesRepository } from './held-sources.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// The blocked-wallet reminder (phase 5 S9e, S9c fix 2): a transfer of this worker's wallet and
// network still SIGNED or BROADCAST longer than TON_CONFIRM_TIMEOUT_MS (the `blocksWallet` rule the
// sender and the balance monitor use) blocks every TON payout until the reconciler or the owner
// settles it. The TON module raises `tonWalletBlocked` once per transfer (refId = the transfer,
// deduped for 30 days); a missed message would leave the wallet blocked in silence. This step
// raises it again once per WALLET_BLOCKED_REMIND_EVERY_MS counted FROM THE BLOCK
// (`<transferId>_wb_<n>`, guard-ref.ts walletBlockedRef, read back as the transfer): the first
// reminder comes a full period after the TON module's own alert, never minutes after it (S9e fix
// CR F6). Only transfers blocking that long are listed (database clock). It runs after the transfer
// sweep, so a transfer that the sweep settled in this tick is not named. Read only: no lock, no
// write but the alert; another wallet's transfers are not this worker's to name.

@Injectable()
export class WalletBlockedStep implements ReconcileStep {
  readonly name = 'walletBlocked';
  private readonly logger = new Logger(WalletBlockedStep.name);

  constructor(
    private readonly sources: HeldSourcesRepository,
    private readonly notifier: ReconcileNotifier,
    @Inject(TON_HOT_WALLET_ADDRESS) private readonly wallet: TonHotWalletAddress,
    @Inject(TON_TIMING) private readonly timing: Pick<TonTiming, 'confirmTimeoutMs'>,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const timeoutMs = this.timing.confirmTimeoutMs;
    // `createdAt < before` is strict: +1 ms makes it `createdAt + timeout + PERIOD <= now`, the same
    // boundary as the skip below (a transfer exactly one period after its block is listed).
    const before = new Date(context.nowMs - timeoutMs - WALLET_BLOCKED_REMIND_EVERY_MS + 1);
    const transfers = await this.sources.blockingTransfers(
      { network: this.wallet.network, rawAddress: this.wallet.rawAddress },
      before,
      RECONCILE_BATCH_LIMIT,
    );
    for (const transfer of transfers) {
      const blockedAtMs = transfer.createdAt.getTime() + timeoutMs;
      // Not a full period yet (the list's bound and this clock differ by a row's own time).
      if (context.nowMs - blockedAtMs < WALLET_BLOCKED_REMIND_EVERY_MS) continue;
      const ref = walletBlockedRef(transfer.id, blockedAtMs, context.nowMs);
      if (ref === null) {
        this.logger.error(`ton transfer ${transfer.id}: no alert id for the blocked wallet`);
        tally.add('failed');
        continue;
      }
      this.logger.error(`the TON hot wallet is still blocked by transfer ${transfer.id}`);
      const queued = await this.notifier.alert(episodeAlert('wb'), ref);
      tally.add(queued ? 'reminded' : 'failed', transfer.id);
    }
    return tally.report();
  }
}
