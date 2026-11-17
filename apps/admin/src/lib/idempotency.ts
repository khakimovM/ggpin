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

/**
 * A fresh `Idempotency-Key` (docs/04 "Admin"): one per action dialog, created when the dialog
 * opens and reused by every retry of that same action.
 */
export function createIdempotencyKey(): string {
  return randomUuid();
}
