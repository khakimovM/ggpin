import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import { checkedId, checkedReason, validationError } from '../../common/admin/admin-input';
import { AppError } from '../../common/exceptions/app-error';
import {
  actorOfInput,
  auditIdOf,
  checkedAuditActor,
  toAuditColumns,
} from '../../common/admin/audit-actor';
import { confirmActorInTx } from '../../common/admin/audit-actor.check';
import { runActorTransaction } from '../../common/admin/admin-transaction';
import { SELF_TARGET_REASON, refuseSelfTarget } from '../../common/admin/admin-target';
import { budgetAdminId, codelessBudgetInTx } from '../../common/admin/codeless-budget';
import { checkManualCreditCap } from '../../common/admin/manual-credit-cap';
import { OwnerOtpVerifier } from '../../common/admin/owner-otp/owner-otp.verifier';
import { requireStepUp, stepUpGiven, verifyStepUp } from '../../common/admin/step-up';
import {
  RECENT_AUTO_TOPUP_WINDOW_MS,
  adjustBindingFlags,
  adjustOtpTarget,
  checkedAdjustAmount,
  checkedOverrideSet,
  refuseUnconfirmedSets,
  type RecentAutoTopup,
} from './wallet-admin.input';
import { WALLET_ADJUST, findAdjustReplay, type Committed } from './wallet-admin.replay';
import { checkedOpenOrdersSet, type OpenOrder } from './wallet-open-orders';
import { WalletTopupReversal } from './wallet-admin-reverse.service';
import { WalletAdminSteps } from './wallet-admin.steps';
import { WalletCache } from './wallet-cache';
import { WalletFrozenAlert } from './wallet-frozen-alert';
import { WalletRepository } from './wallet.repository';

import type { AdjustWalletInput, ReverseTopupInput, WalletChange } from './wallet-admin.types';

export type { AdjustWalletInput, ReverseTopupInput, WalletChange } from './wallet-admin.types';

/**
 * Owner-only money corrections (docs/05 section 9): the owner CLI and the admin panel's OWNER
 * routes (phase 9 S6) call it. Every path is ONE transaction: wallet lock, balance read, AuditLog, ledger entry and the
 * state change; the cache is deleted and the alert queued only after the commit.
 *
 * The AuditLog row is `actorType=CLI, actorId=null` with the operator name in `after.operator`
 * (docs/03, docs/05 section 9), or `actorType=ADMIN, actorId` with `after.adminRole` for the
 * panel (S6), whose admin is re-read under FOR SHARE first in the transaction (S2-6).
 * SECURITY: an ADMIN actor's role is checked here again; a CLI actor is trusted (the server).
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
    const actor = checkedAuditActor(actorOfInput(input));
    const cliAuditId =
      input.auditId === undefined ? undefined : checkedId('auditId', input.auditId);
    const auditId = auditIdOf(actor, cliAuditId);
    const confirm = input.confirmAmountTiyin;
    const target = adjustOtpTarget(userId, auditId);
    const overrideSet = checkedOverrideSet(input.confirmOverrideSet);
    const override = overrideSet !== undefined;
    const openSet = checkedOpenOrdersSet(input.confirmOpenOrdersSet);
    // The code is bound to the override, the top-ups and the open orders as read now (D-46, I-5);
    // checked again below against the same window (one clock read for both).
    const now = this.clock.now();
    const threshold = this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    const given = stepUpGiven(actor, input.otp);
    const otpFlags = given
      ? adjustBindingFlags(
          await this.recentFor(userId, amount, now),
          override,
          await this.openFor(userId, amount),
        )
      : '';
    // A panel debit's code may be asked for by the codeless budget: that reason is bound too.
    const budgetCheck = { amountTiyin: amount, thresholdTiyin: threshold, now };
    const adminFlags =
      given && amount < 0n ? await this.repo.codelessFlags(budgetAdminId(actor), budgetCheck) : [];
    const otpVerified = await verifyStepUp(actor, {
      owner: this.otp,
      otp: input.otp,
      confirmAmountTiyin: confirm,
      action: 'wallet:adjust',
      target,
      flags: otpFlags,
      money: true,
      adminFlags,
    });
    const need = { amountTiyin: amount, confirmAmountTiyin: confirm, thresholdTiyin: threshold };
    // Before any lock, as before S6 (a CLI refusal costs no transaction). The panel's budget is
    // only known under its lock: optimistic here, authoritative below.
    requireStepUp(actor, { ...need, verified: otpVerified, codelessBudgetExceeded: false });

    const committed = await runActorTransaction<Committed>(this.repo, actor, async (tx) => {
      const who = await confirmActorInTx(tx, actor, now);
      await this.steps.lock(tx, userId);
      if (auditId !== undefined) {
        const replay = await findAdjustReplay(this.repo, tx, { userId, auditId, amount, reason });
        if (replay !== null) return replay;
      }
      // F-L1: the matcher may already have credited the money the owner is about to give. The
      // override names the exact set the owner saw, under the lock, at any amount (S9F-L1).
      // I-5: compensation on top of an open order's later automatic refund would pay twice. Both
      // sets the owner confirmed are compared with the ones read under the lock (a debit reads
      // none); POST /admin/confirmations runs the same check unlocked before issuing a code.
      const recent = await this.recentFor(userId, amount, now, tx);
      const open = await this.openFor(userId, amount, tx);
      refuseUnconfirmedSets(amount, { recent, overrideSet, open, openSet });
      if (otpVerified && adjustBindingFlags(recent, override, open) !== otpFlags) {
        throw validationError('otp', 'OTP_MISMATCH'); // a set changed after the code
      }
      await refuseSelfTarget(tx, actor, userId);
      const codelessBudgetExceeded =
        amount < 0n && !otpVerified ? await codelessBudgetInTx(tx, actor, budgetCheck) : undefined;
      requireStepUp(actor, { ...need, verified: otpVerified, codelessBudgetExceeded });
      await checkManualCreditCap(this.repo, tx, {
        amountTiyin: amount,
        capTiyin: this.config.ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN,
        now,
      });

      const before = await this.repo.balance(userId, tx);
      const after = before + amount;
      const audit = await this.steps.createAudit(tx, {
        ...(auditId === undefined ? {} : { id: auditId }),
        ...toAuditColumns(actor),
        action: WALLET_ADJUST,
        targetType: 'User',
        targetId: userId,
        before: { balanceTiyin: before.toString() },
        after: {
          balanceTiyin: after.toString(),
          ...who,
          otpVerified,
          override: recent.length > 0,
          recentAutoTopups: recent.map((payment) => payment.id),
          openOrders: open.map((order) => order.id),
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

  /** The open orders a positive adjustment must confirm (I-5); none for a debit. Like recentFor. */
  async openFor(userId: string, amount: bigint, tx?: Db): Promise<readonly OpenOrder[]> {
    if (amount <= 0n) return [];
    return this.repo.openOrders(checkedId('userId', userId), tx);
  }

  /**
   * `POST /admin/confirmations` for money to a user: the user exists (no code for an unknown id,
   * C-10 a) and is not the acting admin's own account (SA-S6-9, the action refuses it too).
   */
  async confirmTarget(adminId: string, rawUserId: string): Promise<void> {
    const userId = checkedId('userId', rawUserId);
    if (!(await this.repo.userExists(userId))) throw new AppError('NOT_FOUND');
    if (await this.repo.isAdminsOwnUser(adminId, userId)) {
      throw validationError('userId', SELF_TARGET_REASON);
    }
  }

  /** The codeless-budget binding flag for a panel debit or reversal of this size (unlocked). */
  codelessFlags(adminId: string, amountTiyin: bigint, now: Date): Promise<string[]> {
    const thresholdTiyin = this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    return this.repo.codelessFlags(adminId, { amountTiyin, thresholdTiyin, now });
  }

  /** The payment payment:reverse would reverse, with the ledger TOPUP amount (unlocked). */
  payment(paymentId: string): Promise<{ userId: string; amountTiyin: bigint }> {
    return this.reversal.payment(paymentId);
  }

  reverseTopup(input: ReverseTopupInput): Promise<WalletChange> {
    return this.reversal.reverseTopup(input);
  }
}
