import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { errorKind } from './ton-db-errors';
import type { TonGateway } from './ton-gateway';
import { isLowBalance } from './ton-limits';
import { blocksWallet, walletBlockedNotice } from './ton-notices';
import { TonNotifier } from './ton-notifier';
import { TonSnapshotRepository } from './ton-snapshot.repository';
import {
  MAX_DB_CLOCK_SKEW_MS,
  TON_GATEWAY,
  TON_HOT_WALLET_ADDRESS,
  TON_TIMING,
  type TonHotWalletAddress,
  type TonTiming,
} from './ton-tokens';
import { TonTransferRepository } from './ton-transfer.repository';

// The hot-wallet watch (rules/45 "minimum balance alert", docs/06 "Limitlar"): every few minutes
// one balance reading becomes a WalletSnapshot row, and a balance under TON_MIN_BALANCE_ALERT_NANO
// raises `tonLowBalance` (refId = that snapshot) when it first drops, then again every
// LOW_BALANCE_REPEAT_MS while it stays low. The same tick looks for an unresolved transfer older
// than TON_CONFIRM_TIMEOUT_MS (database clock): it blocks every payout until the reconciler or
// the owner decides it, so `tonWalletBlocked` (refId = that transfer, review M4) is raised. At
// boot the worker's clock is compared with the database's (review m5; signing refuses too). A dry
// run has no chain to read (the fake chain's numbers mean nothing to the owner): the watch does
// not start. A failed reading is logged and the next tick tries again; it never stops the worker.

export const BALANCE_CHECK_EVERY_MS = 5 * 60_000;
export const LOW_BALANCE_REPEAT_MS = 6 * 60 * 60_000;

export type BalanceTick = 'OK' | 'LOW' | 'ALERTED' | 'FAILED' | 'BUSY';

type TransferReads = Pick<TonTransferRepository, 'findUnresolved' | 'databaseNowMs'>;

@Injectable()
export class TonBalanceMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TonBalanceMonitor.name);
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<BalanceTick> | null = null;
  private lastAlertAtMs: number | null = null;

  constructor(
    @Inject(TonSnapshotRepository)
    private readonly snapshots: Pick<TonSnapshotRepository, 'record'>,
    private readonly notifier: TonNotifier,
    @Inject(TON_GATEWAY) private readonly gateway: TonGateway,
    @Inject(TON_HOT_WALLET_ADDRESS) private readonly wallet: TonHotWalletAddress,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(TonTransferRepository) private readonly transfers: TransferReads,
    @Inject(TON_TIMING) private readonly timing: Pick<TonTiming, 'confirmTimeoutMs'>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.FULFILLMENT_DRY_RUN) return;
    void this.checkClock();
    this.timer = setInterval(() => void this.tick(), BALANCE_CHECK_EVERY_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Stops the timer and waits for a reading in flight (Prisma disconnects after this). */
  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.inflight;
  }

  /** One reading; a tick while another runs is skipped. Never throws. */
  tick(nowMs: number = Date.now()): Promise<BalanceTick> {
    if (this.inflight !== null) return Promise.resolve('BUSY');
    const run = this.read(nowMs).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** The worker's clock against the database's; true when they agree. Never throws. */
  async checkClock(): Promise<boolean> {
    try {
      const skewMs = Math.abs((await this.transfers.databaseNowMs()) - Date.now());
      if (skewMs <= MAX_DB_CLOCK_SKEW_MS) return true;
      this.logger.error(`the database clock is ${String(skewMs)} ms off ours: no TON is signed`);
      return false;
    } catch (error) {
      this.logger.error(`the database clock could not be read (${errorKind(error)})`);
      return false;
    }
  }

  /** The wallet's unresolved transfer that outlived the confirmation wait, if any: alerted. */
  async checkBlocked(): Promise<string | null> {
    try {
      const unresolved = await this.transfers.findUnresolved(
        this.wallet.network,
        this.wallet.rawAddress,
      );
      if (unresolved === null) return null;
      const now = await this.transfers.databaseNowMs();
      if (!blocksWallet(unresolved.createdAt, now, this.timing.confirmTimeoutMs)) return null;
      this.logger.error(`the TON hot wallet is blocked by transfer ${unresolved.id}`);
      await this.notifier.send([walletBlockedNotice(unresolved.id)]);
      return unresolved.id;
    } catch (error) {
      this.logger.error(`ton wallet-blocked check failed (${errorKind(error)})`);
      return null;
    }
  }

  private async read(nowMs: number): Promise<BalanceTick> {
    await this.checkBlocked();
    try {
      const nanoTon = await this.gateway.getBalance(this.wallet.address);
      const snapshotId = await this.snapshots.record(
        this.wallet.network,
        this.wallet.rawAddress,
        nanoTon,
      );
      if (!isLowBalance(nanoTon, this.config.TON_MIN_BALANCE_ALERT_NANO)) {
        this.lastAlertAtMs = null;
        return 'OK';
      }
      if (this.lastAlertAtMs !== null && nowMs - this.lastAlertAtMs < LOW_BALANCE_REPEAT_MS) {
        return 'LOW';
      }
      this.logger.warn('the TON hot wallet is under TON_MIN_BALANCE_ALERT_NANO: owner alerted');
      await this.notifier.send([{ kind: 'ALERT', alert: 'tonLowBalance', refId: snapshotId }]);
      this.lastAlertAtMs = nowMs;
      return 'ALERTED';
    } catch (error) {
      this.logger.error(`ton balance reading failed (${errorKind(error)})`);
      return 'FAILED';
    }
  }
}
