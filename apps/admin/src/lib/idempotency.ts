import { ResourceIdSchema } from '@repo/shared';
import {
  readStoredEntries,
  writeStoredEntries,
  type AdminActionKind,
  type StoredEntry,
} from './idempotency-store';

export {
  ADMIN_ACTION_KINDS,
  PENDING_ACTIONS_STORAGE_KEY,
  type AdminActionKind,
} from './idempotency-store';

// `crypto.randomUUID` exists only in secure contexts; the fallback builds a v4 UUID from
// getRandomValues, which has no such limit.
function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fresh `Idempotency-Key` (docs/04 "Admin"): 8-128 characters of `A-Z a-z 0-9 _ -`. */
export function createIdempotencyKey(): string {
  return randomUuid();
}

declare const actionIdBrand: unique symbol;
/** `<adminId>/<kind>:<targetId>`, made only by `adminActionId`. */
export type AdminActionId = string & { readonly [actionIdBrand]: true };

/**
 * The one way to name an action in the registry (CR #3). `adminId` is the signed-in admin,
 * `useAdmin().admin.id`, so it exists only inside <RequireAdmin>: without a loaded session no id
 * can be built and no action can be sent. An admin builds only ids with their own id, so another
 * admin's entries in this tab are never shown or used, and never deleted: they come back when that
 * admin signs in here again. A bad id is a programming error and throws.
 */
export function adminActionId(
  adminId: string,
  kind: AdminActionKind,
  targetId: string,
): AdminActionId {
  const admin = ResourceIdSchema.parse(adminId);
  const target = ResourceIdSchema.parse(targetId);
  return `${admin}/${kind}:${target}` as AdminActionId;
}

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

type Entry = Omit<StoredEntry, 'kind'> & { kind: AdminActionKind; reason: string | null };

/**
 * Keys of admin actions (SA M-1, M-1R, M-2; CR #2, #3). A key lives until a 2xx: the server binds
 * it only to the action's audit row (docs/04 "Admin", `Idempotency-Key`), so after a 4xx the same
 * key is safe and keeps a step-up code bound to it valid. After an unknown outcome the server may
 * have applied the action, so every later attempt, also after closing the dialog or a reload, must
 * send the SAME key and get the first result back (`applied: false`) instead of moving money twice.
 *
 * sessionStorage holds the entries that are in flight, unknown or in conflict (ids, key, flags,
 * time; never the reason), so they survive a reload of this tab, not another tab or device.
 */
const entries = new Map<AdminActionId, Entry>();

function persist(): void {
  writeStoredEntries(
    [...entries.values()]
      .filter((entry) => entry.inFlight || entry.unknown || entry.conflict)
      .map(({ adminId, kind, targetId, key, unknown, conflict, inFlight, createdAt }) => ({
        adminId,
        kind,
        targetId,
        key,
        unknown,
        conflict,
        inFlight,
        createdAt,
      })),
  );
}

function load(): void {
  for (const stored of readStoredEntries()) {
    // The tab was reloaded while the request was out: its outcome is unknown.
    const unknown = stored.unknown || stored.inFlight;
    entries.set(adminActionId(stored.adminId, stored.kind, stored.targetId), {
      ...stored,
      unknown,
      inFlight: false,
      reason: null,
    });
  }
}

load();

function parts(action: AdminActionId): Pick<Entry, 'adminId' | 'kind' | 'targetId'> {
  const slash = action.indexOf('/');
  const colon = action.indexOf(':');
  return {
    adminId: action.slice(0, slash),
    kind: action.slice(slash + 1, colon) as AdminActionKind,
    targetId: action.slice(colon + 1),
  };
}

function entryOf(action: AdminActionId, key = createIdempotencyKey()): Entry {
  const existing = entries.get(action);
  if (existing) return existing;
  const entry: Entry = {
    ...parts(action),
    key,
    reason: null,
    unknown: false,
    conflict: false,
    inFlight: false,
    createdAt: Date.now(),
  };
  entries.set(action, entry);
  return entry;
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

/** Write-ahead (SA M-2): call right BEFORE sending; returns the key to send. */
export function beginActionAttempt(action: AdminActionId): string {
  const entry = entryOf(action);
  entry.inFlight = true;
  persist();
  return entry.key;
}

/** A definite refusal (4xx in our envelope) for `key`: nothing was bound, the key stays. */
export function endRefusedAttempt(action: AdminActionId, key: string): void {
  const entry = entries.get(action);
  if (entry?.key !== key) return;
  entry.inFlight = false;
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
  sent: { reason: string; conflict: boolean },
): void {
  const entry = entryOf(action, key);
  entry.unknown = true;
  if (entry.key === key) {
    entry.reason = sent.reason;
    entry.conflict = entry.conflict || sent.conflict;
    entry.inFlight = false;
  }
  persist();
}

/** A 2xx for `key`: compare-and-delete, so a late answer for an old key keeps a newer entry. */
export function settleActionIdempotencyKey(action: AdminActionId, key: string): void {
  if (entries.get(action)?.key !== key) return;
  entries.delete(action);
  persist();
}

/**
 * A confirmed sign-out (SA L-1): drops only plain entries. An unknown, in-conflict or in-flight
 * one stays (fail-closed): the action may have run, so its key must outlive the session. After a
 * 409 the way out is closing the tab until the "start as a new action" step (phase 9 S7).
 */
export function dropPlainActions(): void {
  for (const [action, entry] of entries) {
    if (!entry.unknown && !entry.conflict && !entry.inFlight) entries.delete(action);
  }
  persist();
}
