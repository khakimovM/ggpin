import { Module } from '@nestjs/common';
import { SimulatedFragmentPrices } from '../adapters/simulator/simulated-fragment-prices';
import { COST_SOURCES, type CostSource } from './cost-sources/cost-source';
import { CostSyncService } from './cost-sync.service';
import { FX_SOURCE, type FxSource } from './fx-sources/fx-source';
import { SimulatedFxSource } from './fx-sources/simulated-fx.source';
import { FxSyncService } from './fx-sync.service';
import { PriceSyncProcessor } from './price-sync.processor';
import { PriceSyncScheduler } from './price-sync.scheduler';
import { PricingSyncRepository } from './pricing-sync.repository';

// Phase 3 has no real FX or Fragment price source (owner answer Q6). The simulators are bound
// in every mode, and the sync services refuse a simulated source unless FULFILLMENT_DRY_RUN is
// true: that one check, inside the services, is the gate (tested), so wiring cannot bypass it.
// A real source replaces the binding here when it exists.
@Module({
  providers: [
    { provide: FX_SOURCE, useFactory: (): FxSource => new SimulatedFxSource() },
    {
      provide: COST_SOURCES,
      useFactory: (): readonly CostSource[] => [new SimulatedFragmentPrices()],
    },
    PricingSyncRepository,
    FxSyncService,
    CostSyncService,
    PriceSyncProcessor,
    PriceSyncScheduler,
  ],
})
export class PricingSyncModule {}
