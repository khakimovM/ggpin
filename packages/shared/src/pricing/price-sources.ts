// Labels the worker writes to FxRate.source / CostSnapshot.source and the API judges. Defined
// once for both apps: if the worker's name for fake prices drifted from what the API refuses,
// production could sell at simulated prices (docs/06 "Narx sinxronlash", D-34 (15)).

/** `source` of every row written from a simulated (dry-run) price source. */
export const SIMULATOR_SOURCE = 'simulator';

const DERIVED_PREFIX = 'derived:';
const FX_RATE_ID = /^[A-Za-z0-9_-]+$/;
const DERIVED_SOURCE = /^derived:([A-Za-z0-9_-]+)\*([A-Za-z0-9_-]+)$/;

/**
 * `source` of a derived TON_UZS row: the ids of the TON_USDT and USDT_UZS rows it was computed
 * from, in that order, so the API can judge the parents (a derived row is simulated when either
 * parent is).
 */
export function derivedFxSource(tonUsdtId: string, usdtUzsId: string): string {
  if (!FX_RATE_ID.test(tonUsdtId) || !FX_RATE_ID.test(usdtUzsId)) {
    throw new RangeError('derived FX source needs two plain FxRate ids');
  }
  return `${DERIVED_PREFIX}${tonUsdtId}*${usdtUzsId}`;
}

export function isDerivedFxSource(source: string): boolean {
  return source.startsWith(DERIVED_PREFIX);
}

/** The [TON_USDT id, USDT_UZS id] of a derived source, or null when it is malformed. */
export function parseDerivedFxSource(source: string): readonly [string, string] | null {
  const match = DERIVED_SOURCE.exec(source);
  const tonUsdtId = match?.[1];
  const usdtUzsId = match?.[2];
  return tonUsdtId !== undefined && usdtUzsId !== undefined ? [tonUsdtId, usdtUzsId] : null;
}
