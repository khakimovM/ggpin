import { createHash } from 'node:crypto';
import { AUTO_CREDIT_HORIZON_MS } from '@repo/db';
import { z } from 'zod';
import { MAX_BIGINT_TIYIN, validationError } from '../../common/admin/admin-input';

// Wallet-only checks of the owner CLI; the common ones (reason, operator, ip, ids) live in
// common/admin/admin-input.ts, shared with the card services.

export function checkedAdjustAmount(amountTiyin: bigint): bigint {
  if (amountTiyin === 0n || amountTiyin > MAX_BIGINT_TIYIN || amountTiyin < -MAX_BIGINT_TIYIN) {
    throw validationError('amountTiyin');
  }
  return amountTiyin;
}

/** What the owner's code for wallet:adjust is bound to (ids only; the key makes it one command). */
export function adjustOtpTarget(userId: string, auditId: string | undefined): string {
  return `user ${userId} key ${auditId ?? '-'}`;
}

export function reverseOtpTarget(paymentId: string): string {
  return `payment ${paymentId}`;
}

/**
 * S9 round 3 (F-L1): a positive wallet:adjust looks at the user's AUTOMATIC P2P top-ups first.
 * The matcher may have credited the very transfer the owner is about to pay by hand (a
 * messageStuck job that a re-queue processed), so the adjustment needs an override then. The
 * window is the worker's whole auto-credit horizon (orphan re-queue lookback, 7 days, S9F-L2),
 * counted back from now by `confirmedAt`: a credit confirmed more than 7 days ago is not shown
 * (the owner checks an older transfer by hand, docs/05 §4 runbook).
 */
export const RECENT_AUTO_TOPUP_WINDOW_MS = AUTO_CREDIT_HORIZON_MS;

/** An automatic P2P top-up (Payment CONFIRMED, no review): ids, amount and time only. */
export interface RecentAutoTopup {
  readonly id: string;
  readonly amountTiyin: bigint;
  readonly confirmedAt: Date | null;
}

/** The CLI prints at most this many of them; the code is bound to all of them. */
export const RECENT_AUTO_TOPUPS_SHOWN = 20;

/**
 * The set of automatic top-ups a positive adjustment would override, as 12 hex characters of the
 * sha256 of ALL their sorted ids (not only the ones the CLI prints). The owner passes it back
 * with `--confirm-override=<set>`: an override confirms exactly the payments that were shown,
 * whatever the amount (S9F-L1), and a count alone would not change when one payment leaves the
 * window and another arrives (S9 N1). Short, because it is also shown in the bot message.
 */
export function recentSetHash(recent: readonly RecentAutoTopup[]): string {
  const ids = recent.map((payment) => payment.id).sort();
  return createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 12);
}

/** What `--confirm-override` takes: the set id printed as `recentAutoTopupSet`. */
export const OverrideSetSchema = z.string().regex(/^[0-9a-f]{12}$/);

export function checkedOverrideSet(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!OverrideSetSchema.safeParse(value).success) throw validationError('confirmOverrideSet');
  return value;
}

/** The flags the owner's code is bound to above the threshold (D-46): the override and its set. */
export function adjustOtpFlags(recent: readonly RecentAutoTopup[], override: boolean): string {
  if (!override) return '';
  if (recent.length === 0) return 'override: none';
  return `override: ${String(recent.length)} recent auto top-up(s), set ${recentSetHash(recent)}`;
}
