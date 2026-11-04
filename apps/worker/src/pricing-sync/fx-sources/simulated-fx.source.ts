import { SIMULATOR_SOURCE } from '@repo/shared';
import type { FxQuote, FxSource } from './fx-source';

/**
 * FAKE exchange rates for dev/test (FULFILLMENT_DRY_RUN=true only). These are NOT market data
 * and are never fetched from anywhere: fixed, round numbers in a plausible range, constant so
 * tests and local quotes are deterministic. Derived TON_UZS = 3.2 × 12 650 = 40 480 so'm.
 */
export const SIMULATED_FX_RATES: Readonly<Record<FxQuote['pair'], string>> = {
  USDT_UZS: '12650',
  TON_USDT: '3.2',
};

export class SimulatedFxSource implements FxSource {
  readonly name = SIMULATOR_SOURCE;
  readonly simulated = true;

  fetchRates(): Promise<readonly FxQuote[]> {
    return Promise.resolve([
      { pair: 'USDT_UZS', rate: SIMULATED_FX_RATES.USDT_UZS },
      { pair: 'TON_USDT', rate: SIMULATED_FX_RATES.TON_USDT },
    ]);
  }
}
