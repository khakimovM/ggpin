import { IdempotencyKeySchema, QUOTE_TTL_MS, ResourceIdSchema } from '@repo/shared';
import { z } from 'zod';
import { createIdempotencyKey } from './idempotency';

// The purchase that has left (or is about to leave) this browser and has not been answered for yet,
// written to localStorage BEFORE the request is sent ("write-ahead"). Whatever happens next - the
// answer is lost, the tab is closed or reloaded mid-request, the phone dies - the next visit finds
// the record and asks again with the SAME quote and the SAME `Idempotency-Key`, so the server
// returns the order it may already have made instead of charging a second time.
//
// Why localStorage: another tab of the same browser must see the doubt at once (the `storage` event
// below), and it must survive a closed tab. The record holds a quote id, a key, a time and the
// product label the visitor saw. No amount, no balance, no token, no recipient. It is keyed by user
// id: a different account on the same browser never sees it, and signing out does NOT remove it
// (signing in again must still find it).
//
// One record per user is the only slot. While it is unresolved no OTHER quote is paid (use-create-order).
// The server's answers that resolve it are listed in pay-outcome.ts (`resolvesAttempt`).
// ASSUMPTION for phase 5 (docs/04 "POST /orders", D-49): the server keeps the stored 201 of an
// `Idempotency-Key` as long as the order exists (the `Order` row itself), so a retry within the
// 24 h this client keeps the record is always answered by replay.

/** The longest product label kept with the record (a catalog name plus the chosen variant). */
export const ATTEMPT_LABEL_MAX = 120;

// Control characters (and DEL) have no place in a label; a record that holds one is not ours.
const isControl = (char: string): boolean => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127;

const AttemptSchema = z.strictObject({
  quoteId: ResourceIdSchema,
  key: IdempotencyKeySchema,
  at: z.number().int().nonnegative(),
  label: z
    .string()
    .max(ATTEMPT_LABEL_MAX)
    .refine((text) => ![...text].some(isControl)),
});
export type OrderAttempt = z.infer<typeof AttemptSchema>;

// A key is only useful while its quote can still be paid; twice the quote's life is a safe margin.
const KEY_LIFETIME_MS = QUOTE_TTL_MS * 2;
// An unresolved record is kept until the server answers for it, but not forever.
const ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A clock that runs a little fast is tolerated; a record from the far future is not (it would never
// expire), so it is dropped.
const CLOCK_SKEW_MS = 60_000;
// Versioned: a later shape of the record gets a new prefix and the old keys are simply never read.
const PREFIX = 'ggpin:order-attempt:v1:';

const keys = new Map<string, { key: string; at: number }>();
const cache = new Map<string, OrderAttempt | null>();
const listeners = new Set<() => void>();
let synced = false;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // storage blocked (privacy mode, sandboxed frame): the in-memory copy still works
  }
}

const storageKey = (userId: string) => `${PREFIX}${userId}`;

function isFresh(attempt: OrderAttempt, now: number): boolean {
  return attempt.at <= now + CLOCK_SKEW_MS && now - attempt.at < ATTEMPT_MAX_AGE_MS;
}

function parse(raw: string | null): OrderAttempt | null {
  if (raw === null) return null;
  try {
    const parsed = AttemptSchema.safeParse(JSON.parse(raw));
    return parsed.success && isFresh(parsed.data, Date.now()) ? parsed.data : null;
  } catch {
    return null;
  }
}

// "Storage cannot be read" is not "there is no record": a caller that would act on an absent record
// (wipe the in-memory copy, say) must be able to tell the two apart.
const UNAVAILABLE = Symbol('storage unavailable');

// Reads only: it runs from a render (useSyncExternalStore), which must never write.
function readStored(userId: string): OrderAttempt | null | typeof UNAVAILABLE {
  const store = storage();
  if (store === null) return UNAVAILABLE;
  try {
    return parse(store.getItem(storageKey(userId)));
  } catch {
    return UNAVAILABLE;
  }
}

// Removes records whose JSON is broken or that are stale or from the far future. A record that is
// valid JSON of a shape this version does not know is only ignored, never deleted (it may belong to
// a newer tab). Runs outside render (on subscribe and before a write).
function sweep(): void {
  const store = storage();
  if (store === null) return;
  try {
    for (const name of Object.keys(store)) {
      if (!name.startsWith(PREFIX)) continue;
      let json: unknown;
      try {
        json = JSON.parse(store.getItem(name) ?? '');
      } catch {
        store.removeItem(name); // broken JSON
        continue;
      }
      const known = AttemptSchema.safeParse(json);
      if (known.success && !isFresh(known.data, Date.now())) store.removeItem(name);
    }
  } catch {
    // nothing to clean
  }
}

function persist(userId: string, attempt: OrderAttempt | null): void {
  const store = storage();
  if (store === null) return;
  try {
    if (attempt === null) store.removeItem(storageKey(userId));
    else store.setItem(storageKey(userId), JSON.stringify(attempt));
  } catch {
    // quota or blocked: the in-memory copy still works
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

// Another tab wrote or cleared a record: take it over at once, so a second tab sees the doubt.
function onStorage(event: StorageEvent): void {
  if (event.key === null) {
    cache.clear(); // storage.clear()
    emit();
    return;
  }
  if (!event.key.startsWith(PREFIX)) return;
  const userId = event.key.slice(PREFIX.length);
  const next = parse(event.newValue);
  const current = cache.get(userId) ?? null;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  cache.set(userId, next);
  emit();
}

function installSync(): void {
  if (synced || typeof window === 'undefined') return;
  synced = true;
  window.addEventListener('storage', onStorage);
}

/**
 * The unresolved purchase of this user, if any. A pure read (it is the snapshot of
 * useSyncExternalStore): the same object while nothing changes, `null` for a record that has gone
 * stale. Removing stale records from storage is `sweep`'s job, outside render.
 */
export function getAttempt(userId: string): OrderAttempt | null {
  installSync();
  if (!cache.has(userId)) {
    const stored = readStored(userId);
    cache.set(userId, stored === UNAVAILABLE ? null : stored);
  }
  const attempt = cache.get(userId) ?? null;
  return attempt !== null && isFresh(attempt, Date.now()) ? attempt : null;
}

export function subscribeAttempts(listener: () => void): () => void {
  installSync();
  sweep();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Re-reads the record from storage (not from the cache) and tells the listeners if another tab
 * changed it. A storage that cannot be read leaves the in-memory copy alone.
 */
export function syncFromStorage(userId: string): void {
  const stored = readStored(userId);
  if (stored === UNAVAILABLE) return;
  if (JSON.stringify(stored) === JSON.stringify(cache.get(userId) ?? null)) return;
  cache.set(userId, stored);
  emit();
}

function prune(now: number): void {
  for (const [quoteId, entry] of keys) {
    if (now - entry.at > KEY_LIFETIME_MS) keys.delete(quoteId);
  }
}

/** The key of a quote: made on first use, then the same one for as long as the quote lives. */
function keyOf(quoteId: string): string {
  const now = Date.now();
  prune(now);
  const known = keys.get(quoteId);
  if (known !== undefined) return known.key;
  const key = createIdempotencyKey();
  keys.set(quoteId, { key, at: now });
  return key;
}

/**
 * Writes the record BEFORE the request goes out. When the user already has an unresolved record it
 * is returned untouched (`retry: true`): the one slot is never overwritten, and the caller must
 * only ever re-send THAT quote with THAT key.
 *
 * Without the cross-tab lock another tab can write in the same instant, so the write is read back:
 * when what is stored is not ours (another quote, or another key) the caller has `lost` and sends
 * nothing; it treats the stored record as the purchase in doubt.
 */
export function beginAttempt(
  userId: string,
  quoteId: string,
  label: string,
): { attempt: OrderAttempt; retry: boolean; lost: boolean } {
  sweep();
  const existing = getAttempt(userId);
  if (existing !== null) return { attempt: existing, retry: true, lost: false };
  const attempt: OrderAttempt = {
    quoteId,
    key: keyOf(quoteId),
    at: Date.now(),
    label: [...label]
      .map((char) => (isControl(char) ? ' ' : char))
      .join('')
      .slice(0, ATTEMPT_LABEL_MAX),
  };
  cache.set(userId, attempt);
  persist(userId, attempt);
  const back = readStored(userId);
  if (
    back !== UNAVAILABLE &&
    back !== null &&
    (back.quoteId !== quoteId || back.key !== attempt.key)
  ) {
    cache.set(userId, back);
    emit();
    return { attempt: back, retry: true, lost: true };
  }
  emit();
  return { attempt, retry: false, lost: false };
}

/**
 * A check ended without settling the doubt, so the record must outlive it: if another tab removed
 * it meanwhile (it got a clear refusal for its own first send), it is written back. Only into an
 * EMPTY slot: a record of another quote is never overwritten.
 */
export function reassertAttempt(userId: string, attempt: OrderAttempt): void {
  syncFromStorage(userId);
  if (getAttempt(userId) !== null || !isFresh(attempt, Date.now())) return;
  cache.set(userId, attempt);
  persist(userId, attempt);
  emit();
}

/** The server answered for this quote (an order, or none): it is no longer in doubt. */
export function resolveAttempt(userId: string, quoteId: string): void {
  if (getAttempt(userId)?.quoteId !== quoteId) return;
  cache.set(userId, null);
  persist(userId, null);
  emit();
}

/** The server says there is no order for this quote: its key is spent, the next quote gets a new one. */
export function forgetKey(quoteId: string): void {
  keys.delete(quoteId);
}

/** Forgets everything, memory and storage (tests; a deliberate reset). */
export function resetOrderAttempts(): void {
  keys.clear();
  cache.clear();
  const store = storage();
  try {
    if (store !== null) {
      for (const name of Object.keys(store)) if (name.startsWith(PREFIX)) store.removeItem(name);
    }
  } catch {
    // nothing to clean
  }
  emit();
}
