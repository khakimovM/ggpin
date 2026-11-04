// Which stored price rows may back a customer-facing price. Pure functions: the clock and the
// environment are passed in.

/** `source` of rows written by the worker's simulated (dry-run) price sources. */
export const SIMULATOR_SOURCE = 'simulator';

const DERIVED_PREFIX = 'derived:';
// `derived:<fxRateId>*<fxRateId>` is written by the worker for TON_UZS (TON_USDT x USDT_UZS).
const DERIVED_SOURCE = /^derived:([A-Za-z0-9_-]+)\*([A-Za-z0-9_-]+)$/;

/**
 * How far ahead of the API clock a row may be stamped. The worker stamps rows with its own
 * clock, which may run slightly ahead; a row further in the future is a bad write, and as the
 * "newest" row it would otherwise hide every correct row until real time caught up with it.
 */
export const MAX_CLOCK_SKEW_MS = 60_000;

/** The latest `createdAt` a price row may have to be considered at `now`; later rows are ignored. */
export function latestAcceptedAt(now: Date): Date {
  return new Date(now.getTime() + MAX_CLOCK_SKEW_MS);
}

/**
 * True while `createdAt` is no older than `maxAgeMs` and no more than MAX_CLOCK_SKEW_MS in the
 * future. The age boundary is inclusive: a row exactly `maxAgeMs` old is still fresh, one
 * millisecond older is not.
 */
export function isFresh(createdAt: Date, now: Date, maxAgeMs: number): boolean {
  const age = now.getTime() - createdAt.getTime();
  return age <= maxAgeMs && age >= -MAX_CLOCK_SKEW_MS;
}

export function isDerivedSource(source: string): boolean {
  return source.startsWith(DERIVED_PREFIX);
}

/** The two parent FxRate ids of a derived source, or null when the source is malformed. */
export function parseDerivedParents(source: string): readonly [string, string] | null {
  const match = DERIVED_SOURCE.exec(source);
  const first = match?.[1];
  const second = match?.[2];
  return first !== undefined && second !== undefined ? [first, second] : null;
}
