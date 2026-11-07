import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletNotFoundError } from '@repo/db';
import { scrubSecretsInText } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import {
  checkedId,
  checkedIp,
  checkedOperator,
  checkedOsUser,
  checkedReason,
  validationError,
} from '../../common/admin/admin-input';
import { requireOwnerConfirmation } from '../../common/admin/owner-otp/owner-otp';
import { OwnerOtpVerifier } from '../../common/admin/owner-otp/owner-otp.verifier';
import { adjustOtpTarget, checkedAdjustAmount, reverseOtpTarget } from './wallet-admin.input';
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

import type { AdjustWalletInput, ReverseTopupInput, WalletChange } from './wallet-admin.types';

export type { AdjustWalletInput, ReverseTopupInput, WalletChange } from './wallet-admin.types';

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
    private readonly otp: OwnerOtpVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async adjust(input: AdjustWalletInput): Promise<WalletChange> {
    const userId = checkedId('userId', input.userId);
    const amount = checkedAdjustAmount(input.amountTiyin);
    const reason = checkedReason(input.reason);
    const operator = checkedOperator(input.operator);
    const ip = checkedIp(input.ip);
    const osUser = checkedOsUser(input.osUser);
    const auditId = input.auditId === undefined ? undefined : checkedId('auditId', input.auditId);
    const confirm = input.confirmAmountTiyin;
    const target = adjustOtpTarget(userId, auditId);
    const otpVerified = await this.otp.verifyIfGiven(input.otp, confirm, 'wallet:adjust', target);
    requireOwnerConfirmation(
      amount,
      confirm,
      otpVerified,
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
        after: { balanceTiyin: after.toString(), operator, osUser, otpVerified },
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

  /** The payment payment:reverse would reverse (unlocked; the CLI re-types its amount). */
  async payment(paymentId: string): Promise<{ userId: string; amountTiyin: bigint }> {
    const found = await this.repo.findPayment(checkedId('paymentId', paymentId));
    if (found === null) throw new AppError('NOT_FOUND');
    return { userId: found.userId, amountTiyin: found.amountTiyin };
  }

  async reverseTopup(input: ReverseTopupInput): Promise<WalletChange> {
    const paymentId = checkedId('paymentId', input.paymentId);
    const reason = checkedReason(input.reason);
    const operator = checkedOperator(input.operator);
    const ip = checkedIp(input.ip);
    const osUser = checkedOsUser(input.osUser);
    const confirm = input.confirmAmountTiyin;
    const otpTarget = reverseOtpTarget(paymentId);
    const otpVerified = await this.otp.verifyIfGiven(
      input.otp,
      confirm,
      'payment:reverse',
      otpTarget,
    );

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
      requireOwnerConfirmation(
        amount,
        confirm,
        otpVerified,
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
          osUser,
          otpVerified,
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
      const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
      this.logger.error(`walletFrozen alert for ${committed.ledgerEntryId} not queued: ${reason}`);
      return { ...committed, alertQueued: false };
    }
  }
}
