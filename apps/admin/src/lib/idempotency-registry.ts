// The admin action key registry's storage and entry shape. INTERNAL: screens import the public
// API from `./idempotency`; only that module and this one touch `entries`.
import { ResourceIdSchema } from '@repo/shared';
import {
  readStoredEntries,
  writeStoredEntries,
  type AdminActionKind,
  type StoredEntry,
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

/** The dialog's own fields as they were sent (amount, flags...): memory only, never an OTP code. */
export type ActionFields = Readonly<Record<string, string | boolean>>;

export type Entry = Omit<StoredEntry, 'kind'> & {
  kind: AdminActionKind;
  reason: string | null;
  fields: ActionFields | null;
  /** Counts the attempts of this key in this tab (I-1). */
  attempt: number;
  /**
   * The attempts of this key that are still out, by number (N-1): `inFlight` is true while any
   * is, so a fast 4xx of attempt N never hides attempt N-1 that is still on its way.
   */
  out: Set<number>;
  /** How many attempts ended in this tab: the attempt mark changes on every end too (N-1). */
  endSeq: number;
};

/**
 * Keys of admin actions (SA M-1, M-1R, M-2; CR #2, #3). A key lives until a 2xx: the server binds
 * it only to the action's audit row (docs/04 "Admin", `Idempotency-Key`), so after a 4xx the same
 * key is safe and keeps a step-up code bound to it valid. After an unknown outcome the server may
 * have applied the action, so every later attempt, also after closing the dialog or a reload, must
 * send the SAME key and get the first result back (`applied: false`) instead of moving money twice.
 *
 * sessionStorage holds the entries that are in flight, unknown or in conflict (ids, key, flags,
 * times; never the reason or the fields), so they survive a reload of this tab only.
 */
export const entries = new Map<AdminActionId, Entry>();

// F-1: screens that show registry state (the outcome check) re-render on every change, also one
// made by an answer arriving after its dialog closed.
let version = 0;
const listeners = new Set<() => void>();

export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registryVersion(): number {
  return version;
}

/** Every registry change ends here (writes go through `persist`): stores and notifies. */
export function persist(): void {
  version += 1;
  for (const listener of listeners) listener();
  writeStoredEntries(
    [...entries.values()]
      .filter((entry) => entry.inFlight || entry.unknown || entry.conflict)
      .map((entry) => ({
        adminId: entry.adminId,
        kind: entry.kind,
        targetId: entry.targetId,
        key: entry.key,
        unknown: entry.unknown,
        conflict: entry.conflict,
        inFlight: entry.inFlight,
        createdAt: entry.createdAt,
        ...(entry.sentAt === undefined ? {} : { sentAt: entry.sentAt }),
        ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
        ...(entry.voidTargetId === undefined ? {} : { voidTargetId: entry.voidTargetId }),
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
      fields: null,
      attempt: 0,
      out: new Set(),
      endSeq: 0,
    });
  }
}

load();

/** The admin, kind and target an action id names (the outcome check needs them). */
export function actionParts(action: AdminActionId): Pick<Entry, 'adminId' | 'kind' | 'targetId'> {
  const slash = action.indexOf('/');
  const colon = action.indexOf(':');
  return {
    adminId: action.slice(0, slash),
    kind: action.slice(slash + 1, colon) as AdminActionKind,
    targetId: action.slice(colon + 1),
  };
}

export function freshEntry(action: AdminActionId, key: string): Entry {
  return {
    ...actionParts(action),
    key,
    reason: null,
    fields: null,
    unknown: false,
    conflict: false,
    inFlight: false,
    createdAt: Date.now(),
    attempt: 0,
    out: new Set(),
    endSeq: 0,
  };
}

export function entryOf(action: AdminActionId, key = createIdempotencyKey()): Entry {
  const existing = entries.get(action);
  if (existing) return existing;
  const entry = freshEntry(action, key);
  entries.set(action, entry);
  return entry;
}

/**
 * Attempt `attempt` of the entry's key got its answer (or timed out): it is no longer out, and
 * the attempt mark changes (N-1). Without a number (an old caller) the latest attempt is meant.
 */
export function endAttempt(entry: Entry, attempt: number | undefined): void {
  entry.out.delete(attempt ?? entry.attempt);
  entry.inFlight = entry.out.size > 0;
  entry.endSeq += 1;
  entry.endedAt = Date.now();
}
