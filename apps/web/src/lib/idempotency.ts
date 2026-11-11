'use client';

import { useCallback, useState } from 'react';

// `crypto.randomUUID` exists only in secure contexts; plain http on a LAN address (dev phones)
// lacks it. The fallback builds a v4 UUID from getRandomValues, which has no such limit.
function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fresh `Idempotency-Key` value (docs/04): one per checkout or top-up attempt. */
export function createIdempotencyKey(): string {
  return randomUuid();
}

/**
 * The key of the current attempt. It stays the same across re-renders and across retries of the
 * same attempt (a double tap, a network retry), so the server can recognise the repeat. Call
 * `renew` only when the user starts a genuinely new attempt (new quote, new amount).
 */
export function useIdempotencyKey(): readonly [key: string, renew: () => void] {
  const [key, setKey] = useState(createIdempotencyKey);
  const renew = useCallback(() => setKey(createIdempotencyKey()), []);
  return [key, renew] as const;
}
