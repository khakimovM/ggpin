import { Module, type DynamicModule } from '@nestjs/common';
import { WorkerConfigModule, type WorkerConfig } from './config/config.module';

// Queue consumers (fulfill-order, validate-recipient, price-sync, ...) are registered here
// from phase 1 onwards (docs/02-ARCHITECTURE.md#worker-modullari).
@Module({})
export class WorkerModule {
  // Config is passed in (parsed in main.ts) so booting never depends on ambient process.env.
  static register(config: WorkerConfig): DynamicModule {
    return { module: WorkerModule, imports: [WorkerConfigModule.forRoot(config)] };
  }
}
