import { ResourceIdSchema } from '@repo/shared';
import {
  actionParts,
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

/** A valid `targetId` for the key void, or undefined (the registry target is used then). */
function voidTarget(value: string | undefined): string | undefined {
  return value !== undefined && ResourceIdSchema.safeParse(value).success ? value : undefined;
}

/**
 * Write-ahead (SA M-2): call right BEFORE sending; the key to send and this attempt's number.
 * `voidTargetId`: the id the action's audit row names when it is not the registry target (stored,
 * so a reload still voids with it; docs/04 «Kalitni bekor qilish»).
 */
export function beginAttempt(
  action: AdminActionId,
  voidTargetId?: string,
): { key: string; attempt: number } {
  const entry = entryOf(action);
  const target = voidTarget(voidTargetId);
  if (target !== undefined) entry.voidTargetId = target;
  entry.attempt += 1;
  entry.out.add(entry.attempt);
  entry.inFlight = true;
  entry.sentAt = Date.now();
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
  sent: {
    reason: string;
    conflict: boolean;
    fields?: ActionFields;
    attempt?: number;
    voidTargetId?: string;
  },
): void {
  const entry = entryOf(action, key);
  entry.unknown = true;
  if (entry.key === key) {
    entry.voidTargetId ??= voidTarget(sent.voidTargetId);
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
 * The state of `action`'s attempts: it changes with every `beginAttempt` AND every end (N-1). The
 * outcome check is keyed by it, so a new attempt or the end of one starts it afresh.
 */
export function pendingAttemptMark(action: AdminActionId): string | null {
  const entry = entries.get(action);
  if (!entry) return null;
  const sent = String(entry.sentAt ?? entry.createdAt);
  return `${sent}#${String(entry.attempt)}#${String(entry.endSeq)}`;
}

/** The `targetId` to void `action`'s key with: the stored one, else the registry target. */
export function pendingVoidTarget(action: AdminActionId): string {
  return entries.get(action)?.voidTargetId ?? actionParts(action).targetId;
}

/**
 * The void answered VOIDED for `key` (docs/04, 9-B Q2 = A): the old key is dead on the server and
 * no request with it will ever commit, so a new key replaces it at once. Compare-and-swap on the
 * key, and refused while any attempt is out (N-1): such an attempt was sent after the void and
 * will come back 409, so its entry must not be replaced under it. Returns the new key, or null.
 */
export function replaceVoidedKey(action: AdminActionId, key: string): string | null {
  const entry = entries.get(action);
  if (entry?.key !== key || entry.out.size > 0) return null;
  const next = freshEntry(action, createIdempotencyKey());
  entries.set(action, next);
  persist();
  return next.key;
}

/**
 * A confirmed sign-out (SA L-1): drops only plain entries. An unknown, in-conflict or in-flight
 * one stays (fail-closed): the action may have run, so its key must outlive the session; the
 * key void («Natijani aniqlash») is the way out after it.
 */
export function dropPlainActions(): void {
  for (const [action, entry] of entries) {
    if (!entry.unknown && !entry.conflict && !entry.inFlight) entries.delete(action);
  }
  persist();
}
