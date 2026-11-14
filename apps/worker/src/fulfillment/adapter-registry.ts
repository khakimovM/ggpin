import type { FulfillmentAdapter } from '../adapters/fulfillment-adapter';
import { SimulatedFragmentAdapter } from '../adapters/simulator/simulated-fragment.adapter';
import { SimulatedResellerAdapter } from '../adapters/simulator/simulated-reseller.adapter';
import type { SimulatorScript } from '../adapters/simulator/simulator-script';
import type { WorkerConfig } from '../config/config.module';
import type { AdapterRegistry } from './fulfill-tokens';

/** The simulators' scenario script (one per process; tests script it per order). */
export const SIMULATOR_SCRIPT = Symbol('SIMULATOR_SCRIPT');

// Which adapters exist is decided here and only here (plan §8):
//
// | FULFILLMENT_DRY_RUN | NODE_ENV   | adapters                                             |
// | true                | dev / test | simulators: FRAGMENT (TON-paid), RESELLER_STARS      |
// | true                | production | none: every order is HELD (NO_ADAPTER), nothing runs |
// | false               | any        | none until the real adapters land (S8): NO_ADAPTER   |
//
// The simulators' own constructors refuse production and DRY_RUN=false as a second line.

export function buildAdapterRegistry(
  config: WorkerConfig,
  script: SimulatorScript,
): AdapterRegistry {
  if (!config.FULFILLMENT_DRY_RUN || config.NODE_ENV === 'production') return new Map();
  const adapters: FulfillmentAdapter[] = [
    new SimulatedFragmentAdapter(config, script),
    new SimulatedResellerAdapter(config, script),
  ];
  return new Map(adapters.map((adapter) => [adapter.code, adapter]));
}
