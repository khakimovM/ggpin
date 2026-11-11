import type { Logger } from '@nestjs/common';
import {
  checkedId,
  checkedIp,
  checkedOperator,
  checkedOsUser,
  checkedReason,
  validationError,
} from '../../common/admin/admin-input';
import { requireOwnerConfirmation } from '../../common/admin/owner-otp/owner-otp';
import type { OwnerOtpVerifier } from '../../common/admin/owner-otp/owner-otp.verifier';
import type { Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import type { AppConfig } from '../../config/config.module';
import { reverseOtpTarget } from './wallet-admin.input';
import { PAYMENT_REVERSE, reversalReplay, type Committed } from './wallet-admin.replay';
import type { WalletAdminSteps } from './wallet-admin.steps';
import type { ReverseTopupInput, WalletChange } from './wallet-admin.types';
import type { WalletRepository } from './wallet.repository';

/**
 * payment:reverse (docs/05 section 9): TOPUP_REVERSAL of a confirmed top-up in ONE transaction
 * with the payment CANCELLED and the AuditLog row. Built by WalletAdminService, which keeps the
 * public method (the CLI and the tests call the service).
 */
export class WalletTopupReversal {
  constructor(
    private readonly repo: WalletRepository,
    private readonly otp: OwnerOtpVerifier,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly steps: WalletAdminSteps,
    private readonly logger: Logger,
  ) {}

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
      await this.steps.lock(tx, userId);
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
      const audit = await this.steps.createAudit(tx, {
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
      return this.steps.applied(tx, userId, audit.id, entry.id, after);
    });
    return this.steps.afterCommit(committed);
  }
}
