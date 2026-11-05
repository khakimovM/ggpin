// Redis keys and cached-value codecs shared by the processes that write the ledger (api, and the
// worker for TOPUP/REFUND) and the one that reads balances (api). The balance is never stored in
// Postgres: it is SUM(ledger), cached here and deleted right after every ledger commit
// (.claude/rules/40-domain-money.md). A key typo would leave a stale balance on screen, so every
// process builds the key through this function.
import { ResourceIdSchema } from '../common-schemas';

/** Safety net only: every ledger write deletes the key; this bounds a missed invalidation. */
export const WALLET_CACHE_TTL_SEC = 60;

/** `wallet:{userId}`. Throws on an id that could escape the key namespace (e.g. contains ':'). */
export function walletCacheKey(userId: string): string {
  return `wallet:${ResourceIdSchema.parse(userId)}`;
}

/** Last successful bank-feed poll (epoch ms); the API refuses new top-up intents when it is old. */
export const BANK_FEED_HEARTBEAT_KEY = 'bankfeed:heartbeat';

/** Leader lock: one MTProto connection per auth key, a second one gets AUTH_KEY_DUPLICATED. */
export const BANK_FEED_LEADER_KEY = 'lock:bank-feed';

const CACHED_BALANCE = /^(0|-?[1-9]\d{0,18})$/;

export function encodeCachedBalance(balanceTiyin: bigint): string {
  return balanceTiyin.toString();
}

/**
 * The cached balance, or null for a missing or unreadable value. A corrupt entry must read as
 * a cache miss (recompute from the ledger), never as a balance. The balance can be negative
 * after a reversal, so a leading '-' is valid.
 */
export function decodeCachedBalance(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined || !CACHED_BALANCE.test(raw)) return null;
  return BigInt(raw);
}
