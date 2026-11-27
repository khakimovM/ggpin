// The owner's manual FX rate (`fx:set`, owner CLI; plan Q4 = (a), D-56 (3), D-35 (a), (b), (e)).
// Until a real exchange source exists (D-35, open), the owner types the two sourced rates and the
// API derives TON_UZS from them exactly as the worker's sync does. Constants, not env: the plan's
// env table (§5) has no FX bounds and none may be added in phase 5.
import { z } from 'zod';
import type { FxPair } from '../money';

/** `FxRate.source` of a row the owner typed. A real source may never be named so (D-35 (h)). */
export const MANUAL_FX_SOURCE = 'manual';

/** The pairs the owner types; TON_UZS is always derived (TON_USDT × USDT_UZS, rounded up). */
export const MANUAL_FX_PAIRS = ['USDT_UZS', 'TON_USDT'] as const satisfies readonly FxPair[];
export type ManualFxPair = (typeof MANUAL_FX_PAIRS)[number];

/**
 * Absolute bounds per pair (D-35 (a)): a rate outside is refused whatever the owner confirms, so
 * a slipped digit (12650 typed 126500) can never price the catalog. Wide on purpose: they stop
 * typos, the 10% jump rule with the owner's code stops plausible-looking mistakes.
 * PROVISIONAL figures (2026-11): USDT_UZS around 12 000-13 000 so'm, TON_USDT a few dollars; the
 * owner confirms or changes them before the mainnet test (S12).
 */
export const MANUAL_FX_RATE_BOUNDS: Readonly<
  Record<FxPair, { readonly min: string; readonly max: string }>
> = Object.freeze({
  USDT_UZS: Object.freeze({ min: '9000', max: '20000' }),
  TON_USDT: Object.freeze({ min: '0.5', max: '50' }),
  TON_UZS: Object.freeze({ min: '4500', max: '1000000' }),
});

/**
 * The window of the cumulative jump rule (D-35 (b)): a new manual rate is compared with EVERY
 * manual row of its pair from this window, so ten 9% steps cannot walk the rate 90% away without
 * the owner's code. No manual row in the window (the first one, or a day without any) also needs
 * the code: there is nothing of the same source class to compare with (D-35 (c)).
 */
export const MANUAL_FX_REFERENCE_WINDOW_MS = 24 * 3_600_000;

/**
 * The least time between two manual rates of one pair (audit L-1): the last row's `createdAt`
 * against the CLI's clock, as every freshness rule of the price book. The rate is typed by a
 * person reading a board, with the owner's code on a jump: two in one minute are a mistake or a
 * script, never a market. It also caps the owner's adminAction alerts per pair and keeps a burst
 * of rows out of the price book. A typo is corrected a minute later.
 */
export const MANUAL_FX_MIN_INTERVAL_MS = 60_000;

// The FxRate_rate_check shape (≤ 18 decimals, not zero), no leading zeros, a bounded integer part.
const RATE_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;
const ZERO_RE = /^0(\.0+)?$/;

/** A rate as the owner types it: a positive decimal string, `12650` or `5.215`. */
export const ManualFxRateSchema = z
  .string()
  .regex(RATE_RE)
  .refine((rate) => !ZERO_RE.test(rate));

export const ManualFxPairSchema = z.enum(MANUAL_FX_PAIRS);
