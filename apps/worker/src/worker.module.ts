import { Module } from '@nestjs/common';

// Queue consumers (fulfill-order, validate-recipient, price-sync, ...) are registered here
// from phase 1 onwards (docs/02-ARCHITECTURE.md#worker-modullari).
@Module({})
export class WorkerModule {}
