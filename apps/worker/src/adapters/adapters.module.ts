import { Module } from '@nestjs/common';
import { WORKER_CONFIG } from '../config/config.module';
import { AdapterRouter } from '../fulfillment/adapter-router';
import { SIMULATOR_SCRIPT, buildAdapterRegistry } from '../fulfillment/adapter-registry';
import { FULFILL_ADAPTERS } from '../fulfillment/fulfill-tokens';
import { SimulatorScript } from './simulator/simulator-script';

// The ONE set of fulfillment adapters of the worker process (phase 5 S3b, CR #8): which adapters
// exist is decided by one factory (adapter-registry.ts, plan §8: simulators only in a
// non-production dry run, none otherwise), and both consumers that reach a provider —
// fulfill-order (FulfillmentModule) and validate-recipient (RecipientsModule) — import this
// module, so an adapter holding a session (Fragment cookies, S7/S8) is never built twice.
// Prisma comes from the worker's global PrismaModule (the router reads ProductRoute rows).
@Module({
  providers: [
    { provide: SIMULATOR_SCRIPT, useFactory: () => new SimulatorScript() },
    {
      provide: FULFILL_ADAPTERS,
      inject: [WORKER_CONFIG, SIMULATOR_SCRIPT],
      useFactory: buildAdapterRegistry,
    },
    AdapterRouter,
  ],
  exports: [SIMULATOR_SCRIPT, FULFILL_ADAPTERS, AdapterRouter],
})
export class AdaptersModule {}
