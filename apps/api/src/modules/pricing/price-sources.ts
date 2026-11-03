// Which stored price rows may back a customer-facing price. Pure functions: the clock and the
// environment are passed in.

/** `source` of rows written by the worker's simulated (dry-run) price sources. */
export const SIMULATOR_SOURCE = 'simulator';

const DERIVED_PREFIX = 'derived:';
// `derived:<fxRateId>*<fxRateId>` is written by the worker for TON_UZS (TON_USDT x USDT_UZS).
const DERIVED_SOURCE = /^derived:([A-Za-z0-9_-]+)\*([A-Za-z0-9_-]+)$/;

/**
 * True while `createdAt` is no older than `maxAgeMs`. The boundary is inclusive: a row exactly
 * `maxAgeMs` old is still fresh, one millisecond older is not. A row stamped in the future
 * (clock skew between worker and API) counts as fresh.
 */
export function isFresh(createdAt: Date, now: Date, maxAgeMs: number): boolean {
  return now.getTime() - createdAt.getTime() <= maxAgeMs;
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
