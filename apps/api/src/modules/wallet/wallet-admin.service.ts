import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
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
import {
  RECENT_AUTO_TOPUP_WINDOW_MS,
  adjustOtpFlags,
  adjustOtpTarget,
  checkedAdjustAmount,
  checkedOverrideSet,
  recentSetHash,
  type RecentAutoTopup,
} from './wallet-admin.input';
import { WALLET_ADJUST, findAdjustReplay, type Committed } from './wallet-admin.replay';
import { WalletTopupReversal } from './wallet-admin-reverse.service';
import { WalletAdminSteps } from './wallet-admin.steps';
import { WalletCache } from './wallet-cache';
import { WalletFrozenAlert } from './wallet-frozen-alert';
import { WalletRepository } from './wallet.repository';

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
  private readonly steps: WalletAdminSteps;
  private readonly reversal: WalletTopupReversal;

  constructor(
    private readonly repo: WalletRepository,
    cache: WalletCache,
    alert: WalletFrozenAlert,
    private readonly otp: OwnerOtpVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.steps = new WalletAdminSteps(repo, cache, alert, this.logger);
    this.reversal = new WalletTopupReversal(repo, otp, config, clock, this.steps, this.logger);
  }

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
    const overrideSet = checkedOverrideSet(input.confirmOverrideSet);
    const override = overrideSet !== undefined;
    // The code is bound to the override and the top-ups as read now (D-46); checked again below
    // against the same window (one clock read for both).
    const now = this.clock.now();
    const otpFlags =
      input.otp === undefined
        ? ''
        : adjustOtpFlags(await this.recentFor(userId, amount, now), override);
    const otpVerified = await this.otp.verifyIfGiven(
      input.otp,
      confirm,
      'wallet:adjust',
      target,
      otpFlags,
    );
    requireOwnerConfirmation(
      amount,
      confirm,
      otpVerified,
      this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN,
    );

    const committed = await this.repo.transaction(async (tx): Promise<Committed> => {
      await this.steps.lock(tx, userId);
      if (auditId !== undefined) {
        const replay = await findAdjustReplay(this.repo, tx, { userId, auditId, amount, reason });
        if (replay !== null) return replay;
      }
      // F-L1: the matcher may already have credited the money the owner is about to give. The
      // override names the exact set the owner saw, under the lock, at any amount (S9F-L1).
      const recent = await this.recentFor(userId, amount, now, tx);
      if (recent.length > 0 && overrideSet !== recentSetHash(recent)) {
        throw validationError('user', 'RECENT_AUTO_TOPUP');
      }
      if (otpVerified && adjustOtpFlags(recent, override) !== otpFlags) {
        throw validationError('otp', 'OTP_MISMATCH'); // the set changed after the code
      }

      const before = await this.repo.balance(userId, tx);
      const after = before + amount;
      const audit = await this.steps.createAudit(tx, {
        ...(auditId === undefined ? {} : { id: auditId }),
        ip,
        action: WALLET_ADJUST,
        targetType: 'User',
        targetId: userId,
        before: { balanceTiyin: before.toString() },
        after: {
          balanceTiyin: after.toString(),
          operator,
          osUser,
          otpVerified,
          override: recent.length > 0,
          recentAutoTopups: recent.map((payment) => payment.id),
        },
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
      return this.steps.applied(tx, userId, audit.id, entry.id, after);
    });
    return this.steps.afterCommit(committed);
  }

  // Auto top-ups of the auto-credit horizon (7 days) whose set id a positive adjustment needs as
  // `confirmOverrideSet` (S9F-L1/L2). Without tx: the CLI view; with tx: the check under the lock.
  async recentFor(
    userId: string,
    amount: bigint,
    now: Date = this.clock.now(),
    tx?: Db,
  ): Promise<readonly RecentAutoTopup[]> {
    if (amount <= 0n) return [];
    const since = new Date(now.getTime() - RECENT_AUTO_TOPUP_WINDOW_MS);
    return this.repo.recentAutoTopups(checkedId('userId', userId), since, tx);
  }

  /** The payment payment:reverse would reverse (unlocked; the CLI re-types its amount). */
  payment(paymentId: string): Promise<{ userId: string; amountTiyin: bigint }> {
    return this.reversal.payment(paymentId);
  }

  reverseTopup(input: ReverseTopupInput): Promise<WalletChange> {
    return this.reversal.reverseTopup(input);
  }
}
