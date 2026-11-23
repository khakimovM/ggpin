import { notifyJobSchema, refIdSubject, type FulfillmentAlertKind } from '@repo/shared';

// One home for the episode refIds of the worker (phase 5 S9i, S9e audit N-3): the order reconciler
// (on the DATABASE clock of its tick) and the fulfill settle (on this process's clock, the database
// may be what failed) build the same `<subjectId>_<scope>_<period>` here, so an id for one episode
// is one notify job id whoever sends it. The formats below are pinned by a test of literal ids
// (common/__tests__/episode-ref.spec.ts): a changed format would re-send every open episode.
//
// The refId of the reconciler's owner alerts that must repeat for the SAME order (plan §12): a
// notify job id is deduped for 30 days, so `<orderId>` alone would swallow a second episode in
// silence. The episode is the hour of the DATABASE clock at the tick: while a guard keeps refusing
// the owner hears it again every hour (never more often), and the API renderer still reads the
// order back from the ref (`refIdSubject`: `<orderId>_<scope>_<hour>`). The same holds for a
// CONSUMED_UNMATCHED transfer left in review (audit I-2): `<transferId>_cu_<hour>`, read back as
// the transfer. A stuck order lease (S9d, Q-17) is `<orderId>_lock_<hour>` on `needsReview`: the
// plain order id stays free for the order's real NEEDS_REVIEW alert. An order whose re-queues are
// used up (S9d fix F8) is `<orderId>_abandoned_<day>` on `needsReview`: at most once a day, and
// again on a later day after the 24 h abandon window ran out; the settle stamps the same daily ref
// (abandonedAlertRef, S9d re-review R1), so both on one day are one alert. The tick's clock is
// the database's; the order events it is compared with carry the writing process's clock (see
// order-sweeps.repository.ts). S9e: a HELD order the reconciler may not touch (a guard refused, a
// live payout, no HELD event) is `<orderId>_held_<hour>` on `reconcileGuardRefused`, except one
// kept beside a late chain fact (S9f, owner 2026-11-18): `<orderId>_heldlate_<day>`, and one kept
// beside a transfer that is not EXPIRED: `<orderId>_heldlive_<day>`, each once a day, since only
// the owner can end those states and an hourly repeat would be noise; a transfer
// still blocking the hot wallet is `<transferId>_wb_<n>` on `tonWalletBlocked` (walletBlockedRef:
// n counts whole 6-hour periods since the block, not since the epoch, so the TON module's own first
// alert, refId = the plain transfer id, is followed by a reminder only after a full period).

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How often a transfer still blocking the hot wallet is named to the owner again (S9e). */
export const WALLET_BLOCKED_REMIND_EVERY_MS = 6 * HOUR_MS;

/**
 * What the episode is about: a guard refusal of the NEEDS_REVIEW resolution or of a TON transfer
 * check (subject: the order), a CONSUMED_UNMATCHED transfer awaiting the owner (the transfer), or
 * an order lease stuck while nothing runs, or an order whose re-queues are used up (the order), a
 * HELD order the reconciler may not refund or release (the order, S9e), a transfer blocking the hot
 * wallet past the confirm timeout (the transfer, S9e: walletBlockedRef only), a HELD order kept
 * beside a late chain fact or beside a transfer that is not EXPIRED (the order, S9f: daily).
 */
export type GuardScope =
  'review' | 'ton' | 'cu' | 'lock' | 'abandoned' | 'held' | 'heldlate' | 'heldlive' | 'wb';

/** The scopes whose episode is a period of the clock (`wb` counts from the block instead). */
export type EpochScope = Exclude<GuardScope, 'wb'>;

const ALERT_OF: Readonly<Record<GuardScope, FulfillmentAlertKind>> = {
  review: 'reconcileGuardRefused',
  ton: 'reconcileGuardRefused',
  cu: 'tonConsumedUnmatched',
  lock: 'needsReview',
  abandoned: 'needsReview',
  held: 'reconcileGuardRefused',
  heldlate: 'reconcileGuardRefused',
  heldlive: 'reconcileGuardRefused',
  wb: 'tonWalletBlocked',
};

/** An hour; a day for `abandoned`, `heldlate` and `heldlive`; 6 hours for `wb`. */
const PERIOD_OF: Readonly<Record<GuardScope, number>> = {
  review: HOUR_MS,
  ton: HOUR_MS,
  cu: HOUR_MS,
  lock: HOUR_MS,
  abandoned: DAY_MS,
  held: HOUR_MS,
  heldlate: DAY_MS,
  heldlive: DAY_MS,
  wb: WALLET_BLOCKED_REMIND_EVERY_MS,
};

/** The owner alert an episode of this scope is sent on. */
export function episodeAlert(scope: GuardScope): FulfillmentAlertKind {
  return ALERT_OF[scope];
}

/**
 * `<subjectId>_<scope>_<period>` (the hour, or the day for the daily scopes), or null
 * when the id cannot be part of an alert id (not a plain id of at most 40 characters, or the whole
 * ref would not pass the notify schema's 64): the caller logs it instead, a malformed id is never
 * sent.
 */
export function episodeRef(subjectId: string, scope: EpochScope, nowMs: number): string | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  return checkedRef(subjectId, scope, Math.floor(nowMs / PERIOD_OF[scope]));
}

/**
 * `<transferId>_wb_<n>`, n = whole WALLET_BLOCKED_REMIND_EVERY_MS periods since the transfer began
 * to block the wallet (`blockedAtMs`: its creation + the confirm timeout). Null before the first
 * full period (the TON module's own alert covers it) and for a ref that could not be an alert id.
 * Deterministic: every tick of one period yields the same id (deduped), the next period a new one.
 */
export function walletBlockedRef(
  transferId: string,
  blockedAtMs: number,
  nowMs: number,
): string | null {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(blockedAtMs)) return null;
  const periods = Math.floor((nowMs - blockedAtMs) / PERIOD_OF.wb);
  return periods < 1 ? null : checkedRef(transferId, 'wb', periods);
}

function checkedRef(subjectId: string, scope: GuardScope, index: number): string | null {
  const ref = `${subjectId}_${scope}_${String(index)}`;
  if (refIdSubject(ref) !== subjectId) return null;
  const job = notifyJobSchema.safeParse({
    kind: 'OWNER_ALERT',
    alert: ALERT_OF[scope],
    refId: ref,
  });
  return job.success ? ref : null;
}
