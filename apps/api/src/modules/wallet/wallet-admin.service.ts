import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletNotFoundError } from '@repo/db';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import {
  checkedId,
  checkedIp,
  checkedOperator,
  checkedReason,
  validationError,
} from '../../common/admin/admin-input';
import { checkedAdjustAmount, requireConfirmation } from './wallet-admin.input';
import {
  PAYMENT_REVERSE,
  WALLET_ADJUST,
  findAdjustReplay,
  reversalReplay,
  type Committed,
} from './wallet-admin.replay';
import { WalletCache } from './wallet-cache';
import { WalletFrozenAlert } from './wallet-frozen-alert';
import { WalletRepository, isUniqueViolation, type AuditEntryData } from './wallet.repository';

export interface AdjustWalletInput {
  readonly userId: string;
  /** Signed tiyin, never 0. */
  readonly amountTiyin: bigint;
  readonly reason: string;
  /** Who runs the command (the CLI --operator); stored in AuditLog.after.operator. */
  readonly operator: string;
  /** Optional client address for the AuditLog (IPv4/IPv6 literal). */
  readonly ip?: string | null;
  /** Required when |amount| exceeds ADMIN_CONFIRM_THRESHOLD_TIYIN; must equal `amountTiyin`. */
  readonly confirmAmountTiyin?: bigint;
  /**
   * Optional caller-chosen AuditLog id. The CLI generates one per command, so re-running the same
   * command (after a timeout) finds the first run and writes nothing again. The same id with a
   * different user, amount or reason is a different request and is refused (IDEMPOTENCY_CONFLICT).
   */
  readonly auditId?: string;
}

export interface ReverseTopupInput {
  readonly paymentId: string;
  readonly reason: string;
  readonly operator: string;
  readonly ip?: string | null;
  /** Required when the reversed amount exceeds the threshold; must equal that amount. */
  readonly confirmAmountTiyin?: bigint;
}

export interface WalletChange {
  /** False when this call found the work already done (a replay) and wrote nothing. */
  readonly applied: boolean;
  readonly userId: string;
  readonly auditId: string;
  readonly ledgerEntryId: string;
  /** The balance after the change (for a replay: the balance now). */
  readonly balanceTiyin: bigint;
  /**
   * The user's `purchaseFrozen` flag after the transaction, NOT "balance < 0". Nothing here and
   * no incoming top-up clears it (D-41): only the owner does, with the S8 CLI command
   * `user:unfreeze --reason`.
   */
  readonly frozen: boolean;
  /** This call flipped the flag false -> true, so the owner is owed a walletFrozen alert. */
  readonly newlyFrozen: boolean;
  /**
   * The walletFrozen alert is on the queue. False when none was due (`newlyFrozen` is false) and
   * also when one was due but the enqueue failed, so `newlyFrozen && !alertQueued` means "tell the
   * owner another way".
   */
  readonly alertQueued: boolean;
}

/**
 * Owner-only money corrections (docs/05 section 9). Not reachable over HTTP: the owner CLI calls
 * it. Every path is ONE transaction: wallet lock, balance read, AuditLog, ledger entry and the
 * state change; the cache is deleted and the alert queued only after the commit.
 *
 * The AuditLog row is `actorType=CLI, actorId=null` with the operator name in `after.operator`
 * (docs/03, docs/05 section 9).
 */
@Injectable()
export class WalletAdminService {
  private readonly logger = new Logger(WalletAdminService.name);

  constructor(
    private readonly repo: WalletRepository,
    private readonly cache: WalletCache,
    private readonly alert: WalletFrozenAlert,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async adjust(input: AdjustWalletInput): Promise<WalletChange> {
    const userId = checkedId('userId', input.userId);
    const amount = checkedAdjustAmount(input.amountTiyin);
    const reason = checkedReason(input.reason);
    const operator = checkedOperator(input.operator);
    const ip = checkedIp(input.ip);
    const auditId = input.auditId === undefined ? undefined : checkedId('auditId', input.auditId);
    requireConfirmation(
      amount,
      input.confirmAmountTiyin,
      this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN,
    );

    const committed = await this.repo.transaction(async (tx): Promise<Committed> => {
      await this.lock(tx, userId);
      if (auditId !== undefined) {
        const replay = await findAdjustReplay(this.repo, tx, { userId, auditId, amount, reason });
        if (replay !== null) return replay;
      }

      const before = await this.repo.balance(userId, tx);
      const after = before + amount;
      const audit = await this.createAudit(tx, {
        ...(auditId === undefined ? {} : { id: auditId }),
        ip,
        action: WALLET_ADJUST,
        targetType: 'User',
        targetId: userId,
        before: { balanceTiyin: before.toString() },
        after: { balanceTiyin: after.toString(), operator },
        reason,
      });
      const entry = await this.repo.appendEntry(tx, {
        userId,
        kind: 'ADJUSTMENT',
        amountTiyin: amount,
        refType: 'ADMIN_ACTION',
        refId: audit.id,
        note: reason,
      });
      return this.applied(tx, userId, audit.id, entry.id, after);
    });
    return this.afterCommit(committed);
  }

  async reverseTopup(input: ReverseTopupInput): Promise<WalletChange> {
    const paymentId = checkedId('paymentId', input.paymentId);
    const reason = checkedReason(input.reason);
    const operator = checkedOperator(input.operator);
    const ip = checkedIp(input.ip);

    // Read once without a lock only to learn whose wallet to lock; the owner never changes.
    const known = await this.repo.findPayment(paymentId);
    if (known === null) throw new AppError('NOT_FOUND');
    const userId = known.userId;

    const committed = await this.repo.transaction(async (tx): Promise<Committed> => {
      await this.lock(tx, userId);
      // Re-read under the lock: a concurrent reversal may have finished while we waited.
      const payment = await this.repo.findPayment(paymentId, tx);
      if (payment === null) throw new AppError('NOT_FOUND');
      if (payment.userId !== userId) {
        // The wallet we hold is not the payment owner: never move money on that.
        this.logger.error(`payment ${paymentId} changed owner between the two reads`);
        throw new AppError('INTERNAL_ERROR');
      }

      const reversal = await this.repo.findEntry(tx, {
        userId,
        refType: 'PAYMENT',
        refId: paymentId,
        kind: 'TOPUP_REVERSAL',
      });
      if (reversal !== null)
        return reversalReplay(this.repo, tx, userId, paymentId, reason, reversal.id);
      if (payment.status !== 'CONFIRMED') throw validationError('paymentStatus');

      // Reverse what the ledger actually credited, not what the payment row claims.
      const credited = await this.repo.findEntry(tx, {
        userId,
        refType: 'PAYMENT',
        refId: paymentId,
        kind: 'TOPUP',
      });
      if (credited === null) {
        this.logger.error(`confirmed payment ${paymentId} has no TOPUP ledger entry`);
        throw new AppError('INTERNAL_ERROR');
      }
      const amount = credited.amountTiyin;
      if (amount !== payment.amountTiyin) {
        // No amounts in the log (the audit row carries reversedTiyin); the ledger side wins.
        this.logger.warn(`payment ${paymentId}: credited amount differs from the payment row`);
      }
      requireConfirmation(
        amount,
        input.confirmAmountTiyin,
        this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN,
      );

      const before = await this.repo.balance(userId, tx);
      const after = before - amount;
      if (!(await this.repo.cancelConfirmedPayment(tx, paymentId, this.clock.now()))) {
        throw new AppError('INTERNAL_ERROR'); // cannot happen under the wallet lock
      }
      const audit = await this.createAudit(tx, {
        ip,
        action: PAYMENT_REVERSE,
        targetType: 'Payment',
        targetId: paymentId,
        before: { balanceTiyin: before.toString(), paymentStatus: 'CONFIRMED' },
        after: {
          balanceTiyin: after.toString(),
          paymentStatus: 'CANCELLED',
          reversedTiyin: amount.toString(),
          operator,
        },
        reason,
      });
      const entry = await this.repo.appendEntry(tx, {
        userId,
        kind: 'TOPUP_REVERSAL',
        amountTiyin: -amount,
        refType: 'PAYMENT',
        refId: paymentId,
        note: reason,
      });
      return this.applied(tx, userId, audit.id, entry.id, after);
    });
    return this.afterCommit(committed);
  }

  // A user without a Wallet row is "no such user" to the operator, not a server error.
  private async lock(tx: Db, userId: string): Promise<void> {
    try {
      await this.repo.lock(tx, userId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }

  // A reused AuditLog id that slipped past the replay check (two commands with the same id for
  // DIFFERENT users hold different wallet locks) hits the primary key: a conflict, not a 500.
  private async createAudit(tx: Db, data: AuditEntryData): Promise<{ id: string }> {
    try {
      return await this.repo.createAudit(tx, data);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('IDEMPOTENCY_CONFLICT');
      throw error;
    }
  }

  // A negative balance raises the flag. The flag is never cleared here (D-41: owner CLI
  // `user:unfreeze`), so `frozen` reports the flag as it is and the alert goes out only on the
  // false -> true flip: an already frozen account does not alert again.
  private async applied(
    tx: Db,
    userId: string,
    auditId: string,
    ledgerEntryId: string,
    balanceTiyin: bigint,
  ): Promise<Committed> {
    const newlyFrozen = balanceTiyin < 0n && (await this.repo.freezePurchases(tx, userId));
    const frozen = newlyFrozen || (await this.repo.isPurchaseFrozen(tx, userId));
    return { applied: true, userId, auditId, ledgerEntryId, balanceTiyin, frozen, newlyFrozen };
  }

  // Best effort on purpose: the money is already committed, so a Redis hiccup must not turn a
  // done correction into an error (a CLI retry would only replay it).
  private async afterCommit(committed: Committed): Promise<WalletChange> {
    if (!committed.applied) return { ...committed, alertQueued: false };
    await this.cache.invalidate(committed.userId);
    if (!committed.newlyFrozen) return { ...committed, alertQueued: false };
    try {
      await this.alert.raise(committed.userId, committed.ledgerEntryId);
      return { ...committed, alertQueued: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`walletFrozen alert for ${committed.ledgerEntryId} not queued: ${reason}`);
      return { ...committed, alertQueued: false };
    }
  }
}
