// Timings and names of the price pipeline (docs/06-FULFILLMENT.md "Narx sinxronlash").
// Milliseconds everywhere here: these feed Date arithmetic and BullMQ `every`, which are ms.

/** A quote is payable for 10 minutes (docs/04, roadmap phase 3 acceptance). */
export const QUOTE_TTL_MS = 600_000;

/** A recipient token (phase 5 issues it, POST /quotes consumes it) lives as long as a quote. */
export const RECIPIENT_TOKEN_TTL_MS = 600_000;

/**
 * An FxRate older than this is stale and no quote is issued. The boundary is inclusive: a rate
 * exactly this old is still usable, one millisecond older is not.
 */
export const FX_MAX_AGE_MS = 1_800_000;

/** Same rule and same inclusive boundary for a CostSnapshot. */
export const COST_MAX_AGE_MS = 1_800_000;

/** The worker refreshes FX and supplier costs this often; far below the staleness limits. */
export const PRICE_SYNC_EVERY_MS = 300_000;

/** A new rate that moves more than this (10%) from the last stored one is not written. */
export const FX_MAX_JUMP_BPS = 1000;

/**
 * How far in the future a price row may be stamped and still be read. The worker stamps rows
 * with its own clock, which may run slightly ahead; a row further ahead is a bad write and, as
 * the "newest" row, would otherwise hide every correct one until real time caught up.
 */
export const MAX_CLOCK_SKEW_MS = 60_000;

/** BullMQ job names on the price-sync queue. */
export const PRICE_SYNC_JOBS = { FX: 'fx', COST: 'cost' } as const;
export type PriceSyncJobName = (typeof PRICE_SYNC_JOBS)[keyof typeof PRICE_SYNC_JOBS];
