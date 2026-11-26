import {
  FX_MAX_AGE_MS,
  FX_MAX_JUMP_BPS,
  MANUAL_FX_MIN_INTERVAL_MS,
  MANUAL_FX_RATE_BOUNDS,
  MANUAL_FX_REFERENCE_WINDOW_MS,
  MANUAL_FX_SOURCE,
  fxRateMoveBps,
  fxRateMovesMoreThan,
  fxRateWithin,
  multiplyRates,
  type FxPair,
  type ManualFxPair,
} from '@repo/shared';
import { validationError } from '../../common/admin/admin-input';
import type { Db } from '../../infra/prisma/db';
import { isFresh, latestAcceptedAt } from '../pricing/price-sources';
import type { FxAdminRepository, FxRow } from './fx-admin.repository';

/** What one `fx:set` run would write, and what the owner must confirm with the code. */
export interface FxPlan {
  readonly pair: ManualFxPair;
  readonly rate: string;
  /** The newest row of the pair before this one (any source), for the operator and the audit. */
  readonly previous: FxRow | null;
  /** Why the owner's code is needed (D-35 (b), (d), (e)), `; `-joined; empty when not needed. */
  readonly flags: string;
  /** TON_UZS = TON_USDT × USDT_UZS (rounded up, like the worker), or null with `derivedSkip`. */
  readonly derived: { readonly rate: string; readonly other: FxRow } | null;
  readonly derivedSkip: string | null;
}

const OTHER: Readonly<Record<ManualFxPair, ManualFxPair>> = {
  USDT_UZS: 'TON_USDT',
  TON_USDT: 'USDT_UZS',
};

/**
 * Compares `rate` with every row of `history` (the same source class, the last 24 h; the
 * repository hands over its highest and lowest rate, which is enough: see FxAdminRepository): none
 * means nothing to compare with (the code is needed, D-35 (c)); a move of more than FX_MAX_JUMP_BPS
 * from any of them needs it too and names the farthest one.
 */
export function jumpFlag(pair: FxPair, rate: string, history: readonly FxRow[]): string | null {
  if (history.length === 0) return `${pair}: no manual rate in 24 h`;
  let worst: { readonly row: FxRow; readonly bps: bigint } | null = null;
  for (const row of history) {
    if (!fxRateMovesMoreThan(pair, row.rate, rate, FX_MAX_JUMP_BPS)) continue;
    const bps = fxRateMoveBps(pair, row.rate, rate);
    if (worst === null || bps > worst.bps) worst = { row, bps };
  }
  return worst === null ? null : `${pair}: ${worst.bps.toString()} bps from ${worst.row.id}`;
}

/**
 * Plans one `fx:set` (read in the caller's transaction when it writes): bounds first (refused
 * whatever is confirmed, D-35 (a)), then the per-pair interval (audit L-1), then the jump flags
 * of the pair and of the derived TON_UZS.
 * TON_UZS is derived only from the other pair's newest row when that row is the owner's and
 * still fresh (FX_MAX_AGE_MS): a manual rate is never combined with a stale or simulated one.
 */
export async function planFx(
  repo: FxAdminRepository,
  db: Db,
  input: { readonly pair: ManualFxPair; readonly rate: string; readonly now: Date },
): Promise<FxPlan> {
  const { pair, rate, now } = input;
  if (!fxRateWithin(pair, rate, MANUAL_FX_RATE_BOUNDS[pair])) {
    throw validationError('rate', 'OUT_OF_BOUNDS');
  }
  if (await repo.manualSetAfter(db, pair, new Date(now.getTime() - MANUAL_FX_MIN_INTERVAL_MS))) {
    throw validationError('rate', 'TOO_SOON');
  }
  const notAfter = latestAcceptedAt(now);
  const since = new Date(now.getTime() - MANUAL_FX_REFERENCE_WINDOW_MS);
  const flags: string[] = [];
  const own = jumpFlag(pair, rate, await repo.manualExtremes(db, pair, since, notAfter));
  if (own !== null) flags.push(own);

  const other = await repo.latest(db, OTHER[pair], notAfter);
  let derived: FxPlan['derived'] = null;
  let derivedSkip: string | null = null;
  if (other === null || other.source !== MANUAL_FX_SOURCE) {
    derivedSkip = `the newest ${OTHER[pair]} rate is not a manual one`;
  } else if (!isFresh(other.createdAt, now, FX_MAX_AGE_MS)) {
    derivedSkip = `the newest ${OTHER[pair]} rate is stale`;
  } else {
    const tonUsdt = pair === 'TON_USDT' ? rate : other.rate;
    const usdtUzs = pair === 'USDT_UZS' ? rate : other.rate;
    // Used for COST conversion: rounded up, exactly as the worker derives it (fx-sync.service).
    const tonUzs = multiplyRates(tonUsdt, usdtUzs, 'up');
    if (!fxRateWithin('TON_UZS', tonUzs, MANUAL_FX_RATE_BOUNDS.TON_UZS)) {
      throw validationError('rate', 'DERIVED_OUT_OF_BOUNDS');
    }
    const history = await repo.manualDerivedExtremes(db, since, notAfter);
    const flag = jumpFlag('TON_UZS', tonUzs, history);
    if (flag !== null) flags.push(flag);
    derived = { rate: tonUzs, other };
  }
  return {
    pair,
    rate,
    previous: await repo.latest(db, pair, notAfter),
    flags: flags.join('; '),
    derived,
    derivedSkip,
  };
}
