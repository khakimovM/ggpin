import type { ActorInput } from '../../common/admin/audit-actor';
import type { OtpAnswer } from '../../common/admin/owner-otp/owner-otp';

// Inputs and the result of WalletAdminService (the owner CLI's money corrections, docs/05 §9).

export type AdjustWalletInput = AdjustWalletFields & ActorInput;

export interface AdjustWalletFields {
  readonly userId: string;
  /** Signed tiyin, never 0. */
  readonly amountTiyin: bigint;
  readonly reason: string;
  /** Above ADMIN_CONFIRM_THRESHOLD_TIYIN: equal to `amountTiyin`, plus the owner's code (D-46). */
  readonly confirmAmountTiyin?: bigint;
  readonly otp?: OtpAnswer;
  /**
   * Optional caller-chosen AuditLog id (CLI; an admin's comes from its Idempotency-Key). The CLI generates one per command, so re-running the same
   * command (after a timeout) finds the first run and writes nothing again. The same id with a
   * different user, amount or reason is a different request and is refused (IDEMPOTENCY_CONFLICT).
   */
  readonly auditId?: string;
  /**
   * Adjust although the user got automatic P2P top-ups recently (S9 F-L1): the owner checked it
   * is not the same money. The value is the set id of exactly those payments (`recentSetHash`,
   * 12 hex); a different or missing one is refused under the lock (S9F-L1). AuditLog.after keeps
   * `override` and the payment ids.
   */
  readonly confirmOverrideSet?: string;
}

export type ReverseTopupInput = ReverseTopupFields & ActorInput;

export interface ReverseTopupFields {
  readonly paymentId: string;
  readonly reason: string;
  /** Above the threshold: equal to the reversed amount, plus the owner's code (D-46). */
  readonly confirmAmountTiyin?: bigint;
  readonly otp?: OtpAnswer;
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
