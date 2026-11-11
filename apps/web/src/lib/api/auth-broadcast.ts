// Tells the other tabs of this browser that the cookie session changed. Cookies are shared by all
// tabs, but each tab holds its own in-memory auth state (signed out, lost, cached private data):
// without a message, a tab that stayed open keeps showing the previous user's data, or keeps
// refreshing a session another tab has just ended.
//
// The message carries only the event name, never user data. `BroadcastChannel` is the transport;
// browsers without it fall back to a `storage` event on a key that is written and removed at once
// (the event fires in the OTHER tabs only, so a tab never receives its own message).
//
// A tab uses ONE channel object for both sending and receiving. A channel object never receives
// what it posted itself, but a second object of the same name in the same page would: a tab that
// opened a fresh channel per message would be told about its own sign-in, and would then wipe the
// user it had just loaded.

export const AUTH_CHANNEL_NAME = 'ggpin-auth';
export const AUTH_STORAGE_KEY = 'ggpin-auth-event';

export type AuthEvent = 'signed-out' | 'signed-in';

const isAuthEvent = (value: unknown): value is AuthEvent =>
  value === 'signed-out' || value === 'signed-in';

function readEvent(raw: unknown): AuthEvent | null {
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) return null;
  return isAuthEvent(raw.type) ? raw.type : null;
}

let channel: BroadcastChannel | null = null;

function sharedChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  channel ??= new BroadcastChannel(AUTH_CHANNEL_NAME);
  return channel;
}

export function broadcastAuthEvent(type: AuthEvent): void {
  if (typeof window === 'undefined') return;
  try {
    const shared = sharedChannel();
    if (shared !== null) {
      shared.postMessage({ type });
      return;
    }
    // Storage can be blocked (private mode, sandboxed iframe): the other tabs then catch up on
    // their next request, which is what happened before this message existed.
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ type, at: Date.now() }));
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Best effort by design.
  }
}

/** Returns the unsubscribe function. Events from this very tab are never delivered. */
export function subscribeAuthEvents(handler: (type: AuthEvent) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const shared = sharedChannel();
  if (shared !== null) {
    const onMessage = (message: MessageEvent<unknown>) => {
      const type = readEvent(message.data);
      if (type !== null) handler(type);
    };
    shared.addEventListener('message', onMessage);
    return () => shared.removeEventListener('message', onMessage);
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_STORAGE_KEY || event.newValue === null) return;
    try {
      const type = readEvent(JSON.parse(event.newValue));
      if (type !== null) handler(type);
    } catch {
      // A foreign or corrupted value: ignore.
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
