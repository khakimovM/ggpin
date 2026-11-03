import type { FxPair } from '@repo/shared';
import { z } from 'zod';

/**
 * Pairs an FX source quotes directly. TON_UZS is never fetched: it is derived from these two
 * (TON_USDT × USDT_UZS, rounded up) so the three stored rates can never disagree.
 */
export const SOURCED_FX_PAIRS = ['USDT_UZS', 'TON_USDT'] as const satisfies readonly FxPair[];
export type SourcedFxPair = (typeof SOURCED_FX_PAIRS)[number];

export interface FxQuote {
  readonly pair: SourcedFxPair;
  /** Decimal string: QUOTE major units per 1 BASE major unit (FxRate.rate). */
  readonly rate: string;
}

/**
 * Where FX rates come from. Phase 3 has only the simulator (owner answer Q6: no real source,
 * no external URL); a real exchange source implements this same interface later.
 */
export interface FxSource {
  /** Written to FxRate.source. The API refuses `simulator` rates in production (Q15). */
  readonly name: string;
  /** Fake data. A simulated source is used only while FULFILLMENT_DRY_RUN=true. */
  readonly simulated: boolean;
  /**
   * Raw quotes. Typed `unknown` on purpose: whatever a source returns is untrusted input and the
   * sync service validates every item with FxQuoteSchema before using it.
   */
  fetchRates(): Promise<readonly unknown[]>;
}

export const FX_SOURCE = Symbol('FX_SOURCE');

// Same shape the FxRate_rate_check constraint accepts (≤ 18 decimals, not zero), plus no
// leading zeros and a bounded integer part: a source answer is untrusted input even when typed.
const RATE_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;
const ZERO_RE = /^0(\.0+)?$/;

export const FxQuoteSchema = z
  .object({
    pair: z.enum(SOURCED_FX_PAIRS),
    rate: z
      .string()
      .regex(RATE_RE, 'rate must be a positive decimal string with at most 18 decimals')
      .refine((rate) => !ZERO_RE.test(rate), 'rate must be positive'),
  })
  .strict();
