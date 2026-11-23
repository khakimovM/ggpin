import {
  createIdempotencyKey,
  endAttempt,
  entries,
  entryOf,
  freshEntry,
  persist,
  type ActionFields,
  type AdminActionId,
} from './idempotency-registry';

export {
  ADMIN_ACTION_KINDS,
  PENDING_ACTIONS_STORAGE_KEY,
  type AdminActionKind,
} from './idempotency-store';
export {
  registryVersion,
  subscribeRegistry,
  actionParts,
  adminActionId,
  createIdempotencyKey,
  type ActionFields,
  type AdminActionId,
} from './idempotency-registry';

/** What a parent may read back (to refill its own fields after an unknown outcome). */
export interface PendingAction {
  key: string;
  /** The reason that was sent, kept in memory only; null after a reload. Never the OTP code. */
  reason: string | null;
  /** The last attempt may have been applied: no answer, 5xx, not our envelope, 409, or a reload. */
  unknown: boolean;
  /** A 409 IDEMPOTENCY_CONFLICT was seen for this key. */
  conflict: boolean;
}

/** The key of `action`: the stored one if any, else a new one that stays until a 2xx. */
export function actionIdempotencyKey(action: AdminActionId): string {
  return entryOf(action).key;
}

/** The registry entry of `action`, or null. Contract: read-only; parents refill from it. */
export function pendingAction(action: AdminActionId): PendingAction | null {
  const entry = entries.get(action);
  if (!entry) return null;
  const { key, reason, unknown, conflict } = entry;
  return { key, reason, unknown, conflict };
}

/** The fields sent with an attempt whose outcome is unknown (memory only; null after a reload). */
export function pendingFields(action: AdminActionId): ActionFields | null {
  const entry = entries.get(action);
  return entry?.unknown ? entry.fields : null;
}

/** Write-ahead (SA M-2): call right BEFORE sending; the key to send and this attempt's number. */
export function beginAttempt(action: AdminActionId): { key: string; attempt: number } {
  const entry = entryOf(action);
  entry.attempt += 1;
  entry.out.add(entry.attempt);
  entry.inFlight = true;
  entry.sentAt = Date.now();
  entry.sinceMono = performance.now();
  persist();
  return { key: entry.key, attempt: entry.attempt };
}

/** `beginAttempt` for callers that need only the key. */
export function beginActionAttempt(action: AdminActionId): string {
  return beginAttempt(action).key;
}

/**
 * A definite refusal (4xx in our envelope) for `key`: nothing was bound by THIS attempt, the key
 * stays. Only `attempt` stops being out (N-1): an older attempt of the key may still be on its way.
 */
export function endRefusedAttempt(action: AdminActionId, key: string, attempt?: number): void {
  const entry = entries.get(action);
  if (entry?.key !== key) return;
  endAttempt(entry, attempt);
  persist();
}

/**
 * The attempt sent with `key` has an unknown outcome. Creates the entry when it is gone (the
 * answer may arrive after the dialog unmounted). An entry holding another key keeps that key, its
 * reason and its conflict flag (CR #5): it may already be bound too, so it is only flagged.
 */
export function markActionOutcomeUnknown(
  action: AdminActionId,
  key: string,
  sent: { reason: string; conflict: boolean; fields?: ActionFields; attempt?: number },
): void {
  const entry = entryOf(action, key);
  entry.unknown = true;
  if (entry.key === key) {
    entry.reason = sent.reason;
    entry.fields = sent.fields ?? entry.fields;
    entry.conflict = entry.conflict || sent.conflict;
    endAttempt(entry, sent.attempt);
  }
  persist();
}

/** A 2xx for `key`: compare-and-delete, so a late answer for an old key keeps a newer entry. */
export function settleActionIdempotencyKey(action: AdminActionId, key: string): void {
  if (entries.get(action)?.key !== key) return;
  entries.delete(action);
  persist();
}

/** Whether any attempt of `action` is still out in this tab (N-1): no verdict while one is. */
export function pendingInFlight(action: AdminActionId): boolean {
  return (entries.get(action)?.out.size ?? 0) > 0;
}

/**
 * How long ago the last attempt of `action` left OR ended, whichever is later (its creation if
 * none left yet), or null. The server may still run a request that left long ago and is still out,
 * so the wait counts from its end too (N-1). Within this tab the wall clock and the monotonic clock
 * must both agree (the smaller wins), so a clock jumped forward cannot open the 60 s bound early
 * (SA-2); after a reload the monotonic clock counts from the reload (R-2), and a wall time in the
 * future counts as "just now" (wait longer, never shorter).
 */
export function pendingElapsedMs(action: AdminActionId): number | null {
  const entry = entries.get(action);
  if (!entry) return null;
  const now = Date.now();
  const wallFrom = Math.max(entry.sentAt ?? entry.createdAt, entry.endedAt ?? 0);
  const monoFrom = Math.max(entry.sinceMono, entry.endedMono ?? entry.sinceMono);
  const wall = Math.max(0, now - wallFrom);
  return Math.min(wall, Math.max(0, performance.now() - monoFrom));
}

/**
 * The state of `action`'s attempts: it changes with every `beginAttempt` AND every end (N-1), so a
 * search verdict given while an attempt was out no longer counts once that attempt ends.
 */
export function pendingAttemptMark(action: AdminActionId): string | null {
  const entry = entries.get(action);
  if (!entry) return null;
  const sent = String(entry.sentAt ?? entry.createdAt);
  return `${sent}#${String(entry.attempt)}#${String(entry.endSeq)}`;
}

/**
 * "Start as a new action" (Q1 = A): the outcome check proved the old key wrote no audit row and
 * the server's bound has passed, so a new key may be used. Compare-and-swap on `key` AND on the
 * attempt state the search was made after (R-1, N-1): a later attempt, or the end of one that was
 * out, may have been applied, so an older "not found" no longer counts and nothing is replaced.
 * Refused while any attempt is out, and unless both now and at the search (`searchedElapsedMs`,
 * SA I-2) at least `minElapsedMs` had passed. Returns the new key, or null.
 */
export function restartAction(
  action: AdminActionId,
  key: string,
  minElapsedMs: number,
  searchedAfter: string,
  searchedElapsedMs: number,
): string | null {
  const entry = entries.get(action);
  if (entry?.key !== key || entry.out.size > 0) return null;
  if (pendingAttemptMark(action) !== searchedAfter) return null;
  if (searchedElapsedMs < minElapsedMs) return null;
  if ((pendingElapsedMs(action) ?? 0) < minElapsedMs) return null;
  const next = freshEntry(action, createIdempotencyKey());
  entries.set(action, next);
  persist();
  return next.key;
}

/**
 * A confirmed sign-out (SA L-1): drops only plain entries. An unknown, in-conflict or in-flight
 * one stays (fail-closed): the action may have run, so its key must outlive the session; the
 * outcome check ("start as a new action") is the way out after it.
 */
export function dropPlainActions(): void {
  for (const [action, entry] of entries) {
    if (!entry.unknown && !entry.conflict && !entry.inFlight) entries.delete(action);
  }
  persist();
}
