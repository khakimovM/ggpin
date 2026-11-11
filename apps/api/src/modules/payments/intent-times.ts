// The deadline a new P2P intent is created with. Its reservation end comes from @repo/shared
// (`reservedUntilAtCreation`), the formula the worker and the database guard share.

/** `createdAt + TOPUP_INTENT_TTL_SEC`: until then the request waits for the transfer. */
export function intentExpiresAt(createdAt: Date, ttlSec: number): Date {
  return new Date(createdAt.getTime() + ttlSec * 1000);
}
