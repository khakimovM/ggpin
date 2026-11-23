import { createHash } from 'node:crypto';
import { AUTO_CREDIT_HORIZON_MS } from '@repo/db';
import { ADMIN_ADJUST_MAX_TIYIN, AdminConfirmSetSchema } from '@repo/shared';
import { validationError } from '../../common/admin/admin-input';
import {
  OPEN_ORDERS_REASON,
  openOrdersConfirmed,
  openOrdersFlag,
  type OpenOrder,
} from './wallet-open-orders';

// Wallet-only checks of the owner CLI; the common ones (reason, operator, ip, ids) live in
// common/admin/admin-input.ts, shared with the card services.

/** Non-zero and at most 1 000 000 000 so'm either way (SA-S6-6), for the CLI and the panel. */
export function checkedAdjustAmount(amountTiyin: bigint): bigint {
  if (
    amountTiyin === 0n ||
    amountTiyin > ADMIN_ADJUST_MAX_TIYIN ||
    amountTiyin < -ADMIN_ADJUST_MAX_TIYIN
  ) {
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

/**
 * What `--confirm-override` takes: the set id printed as `recentAutoTopupSet`. The panel's own
 * schema, not a copy of it (CR #6): the CLI and the panel can never accept different set ids.
 */
export const OverrideSetSchema = AdminConfirmSetSchema;

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

/**
 * Every flag a wallet:adjust code is bound to: the override's and the open orders' (I-5), joined
 * by `; ` (admin-otp-flags.ts shows each). Without open orders it is `adjustOtpFlags` unchanged,
 * so the CLI's binding of an adjustment without them is what it was before S7a.
 */
export function adjustBindingFlags(
  recent: readonly RecentAutoTopup[],
  override: boolean,
  open: readonly Pick<OpenOrder, 'id'>[],
): string {
  return [adjustOtpFlags(recent, override), openOrdersFlag(open)]
    .filter((flag) => flag !== '')
    .join('; ');
}

/** What a positive adjustment confirmed, next to what the server read (F-L1, I-5). */
export interface AdjustSets {
  readonly recent: readonly RecentAutoTopup[];
  readonly overrideSet: string | undefined;
  readonly open: readonly Pick<OpenOrder, 'id'>[];
  readonly openSet: string | undefined;
}

/**
 * The two set refusals of wallet:adjust, `400 fields[{ path: "user", code }]`: the recent automatic
 * top-ups (`RECENT_AUTO_TOPUP`, S9F-L1) and the open orders (`OPEN_ORDERS`, I-5). The action runs
 * it under the wallet lock (authoritative); `POST /admin/confirmations` runs the very same check
 * on unlocked reads before issuing a code (owner decision 2026-11-22), so a code is never spent
 * on an adjustment that would be refused anyway.
 */
export function refuseUnconfirmedSets(amountTiyin: bigint, sets: AdjustSets): void {
  if (sets.recent.length > 0 && sets.overrideSet !== recentSetHash(sets.recent)) {
    throw validationError('user', 'RECENT_AUTO_TOPUP');
  }
  if (!openOrdersConfirmed(amountTiyin, sets.open, sets.openSet)) {
    throw validationError('user', OPEN_ORDERS_REASON);
  }
}
