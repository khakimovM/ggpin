'use client';

import { readPayTokenFromHash } from '@repo/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

// The pay-link token lives in the URL FRAGMENT (`#t=`, D-39): no server and no Referer ever sees it.
// It is kept for this TAB only (D-50): in memory, and in `sessionStorage` under the request's id so
// that a reload keeps working. There is ONE token per tab: keeping a new one drops the others. It is
// erased as soon as the request has ended (paid, cancelled, expired, the token answered 404,
// `expiresAt` passed). Never `localStorage`, cookies, a query key or a log.
//
// After a request has ended a token-less marker (`ggpin:pay-done:<id>`: id and status, no secret)
// stays, so a reload says "this request is finished" instead of "this link is wrong".

const STORE_PREFIX = 'ggpin:pay:';
const DONE_PREFIX = 'ggpin:pay-done:';

export type PayDoneStatus = 'PAID' | 'CANCELLED' | 'EXPIRED';
const DONE_STATUSES: readonly string[] = ['PAID', 'CANCELLED', 'EXPIRED'];

interface Kept {
  intentId: string;
  token: string;
  /** Unknown until the first answer arrives. */
  expiresAt: string | null;
}

let memory: { intentId: string; token: string | null } | null = null;
const doneInMemory = new Set<string>();
const listeners = new Set<() => void>();

// The fragment must be read when this module is evaluated, i.e. before hydration: Next's router
// rewrites the address bar from its own state (which has no fragment) in the commit that hydrates
// the page, and `useSyncExternalStore` only reaches its client snapshot AFTER that commit.
const landing =
  typeof window === 'undefined'
    ? null
    : { path: window.location.pathname, token: readPayTokenFromHash(window.location.hash) };

function emit(): void {
  listeners.forEach((listener) => listener());
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null; // blocked storage: the page still works, it just does not survive a reload
  }
}

function storedKeys(prefix: string): string[] {
  const store = storage();
  if (store === null) return [];
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    // Unreadable storage: nothing to list.
  }
  return keys;
}

function readKept(intentId: string): Kept | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(STORE_PREFIX + intentId);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { token, expiresAt } = value as Record<string, unknown>;
    if (typeof token !== 'string' || readPayTokenFromHash(`#t=${token}`) === null) return null;
    if (expiresAt !== null && typeof expiresAt !== 'string') return null;
    return { intentId, token, expiresAt };
  } catch {
    return null;
  }
}

function keep(entry: Kept): void {
  try {
    storage()?.setItem(STORE_PREFIX + entry.intentId, JSON.stringify(entry));
  } catch {
    // Quota or blocked: memory still holds it.
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to remove.
  }
}

const isPast = (expiresAt: string | null): boolean =>
  expiresAt !== null && Date.parse(expiresAt) <= Date.now();

/**
 * One token per tab: every kept token of another request goes, and so does any that has expired.
 * `current` is the request whose token stays (null: only the expired ones are swept).
 */
function sweep(current: string | null): void {
  for (const key of storedKeys(STORE_PREFIX)) {
    const intentId = key.slice(STORE_PREFIX.length);
    if (current !== null && intentId !== current) remove(key);
    else if (isPast(readKept(intentId)?.expiresAt ?? null)) remove(key);
  }
}

/**
 * What the page sees. It only READS storage (it runs during render); every write is made from an
 * effect, below.
 */
function capture(intentId: string): string | null {
  if (typeof window === 'undefined') return null;
  // A fragment in the address is the newest link and wins; then the landing address (see above);
  // without one the token already kept for this tab stays.
  let fromHash = readPayTokenFromHash(window.location.hash);
  if (fromHash === null && memory === null && landing?.path.endsWith(`/pay/${intentId}`)) {
    fromHash = landing.token;
  }
  if (fromHash !== null) {
    if (memory?.intentId !== intentId || memory.token !== fromHash) {
      memory = { intentId, token: fromHash };
    }
    return fromHash;
  }
  if (memory?.intentId === intentId) return memory.token;
  const kept = readKept(intentId);
  const usable = kept !== null && !isPast(kept.expiresAt) ? kept.token : null;
  memory = { intentId, token: usable };
  return usable;
}

/** Writes a token that has just been taken, only when it differs from the stored one. */
function persistToken(intentId: string, token: string): void {
  const stored = readKept(intentId);
  // The same token keeps the expiry already learnt; a new one starts without.
  if (stored?.token !== token) keep({ intentId, token, expiresAt: null });
  sweep(intentId);
}

/** The answer's `expiresAt` goes next to the token, so a stale entry dies on its own. */
export function rememberPayExpiry(intentId: string, expiresAt: string): void {
  if (memory?.intentId !== intentId || memory.token === null) return;
  if (readKept(intentId)?.expiresAt === expiresAt) return;
  keep({ intentId, token: memory.token, expiresAt });
}

/**
 * Erases the token everywhere: the tab's storage, the module's memory and the landing copy. Called
 * when the request has ended or the server stopped knowing the token.
 */
export function clearPayToken(intentId: string): void {
  remove(STORE_PREFIX + intentId);
  if (landing !== null) landing.token = null;
  if (memory?.intentId === intentId && memory.token === null) return;
  memory = { intentId, token: null };
  emit();
}

/** The request has ended: leave a marker with no secret in it, so a reload can say so. */
export function markPayDone(intentId: string, status: PayDoneStatus): void {
  if (hasPayDone(intentId)) return;
  doneInMemory.add(intentId);
  try {
    storage()?.setItem(DONE_PREFIX + intentId, JSON.stringify({ intentId, status }));
  } catch {
    // Memory still knows it for this page's life.
  }
  emit();
}

export function hasPayDone(intentId: string): boolean {
  if (doneInMemory.has(intentId)) return true;
  try {
    const raw = storage()?.getItem(DONE_PREFIX + intentId) ?? null;
    if (raw === null) return false;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return false;
    const { intentId: id, status } = value as Record<string, unknown>;
    return id === intentId && typeof status === 'string' && DONE_STATUSES.includes(status);
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
  };
}

/** Whether a finished request is on record for this tab (see `markPayDone`). */
export function usePayDone(intentId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasPayDone(intentId),
    () => false,
  );
}

/**
 * `undefined` until the page has hydrated (the server never sees a fragment), then the token or
 * `null` when the link carries none, a malformed one, or the token was erased. The fragment is
 * removed with `router.replace`, not a bare `history.replaceState`: Next's router rewrites the
 * address bar from its own state (on `router.refresh()`, a language switch), and a bare
 * replaceState would let it put the fragment back. `?locale=` stays. A fragment that arrives later
 * (`hashchange`: a new link pasted into the same tab) is taken and stripped the same way.
 */
export function usePayToken(intentId: string): string | null | undefined {
  const router = useRouter();
  const token = useSyncExternalStore(
    subscribe,
    () => capture(intentId),
    () => undefined,
  );
  useEffect(() => {
    if (typeof token === 'string') persistToken(intentId, token);
    else if (token === null) sweep(null);
  }, [intentId, token]);
  useEffect(() => {
    const strip = () => {
      if (window.location.hash === '') return;
      router.replace(window.location.pathname + window.location.search, { scroll: false });
    };
    if (token !== undefined) strip();
    window.addEventListener('hashchange', strip);
    return () => window.removeEventListener('hashchange', strip);
  }, [router, token]);
  return token;
}

/** Forgets everything of this module, in memory and in this tab's storage (tests). */
export function resetPayToken(): void {
  memory = null;
  doneInMemory.clear();
  if (landing !== null) landing.token = null;
  for (const key of [...storedKeys(STORE_PREFIX), ...storedKeys(DONE_PREFIX)]) remove(key);
}
