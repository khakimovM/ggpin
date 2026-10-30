import { Module, type DynamicModule } from '@nestjs/common';
import { WorkerConfigModule, type WorkerConfig } from './config/config.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';

// Queue processors (fulfill-order, validate-recipient, price-sync, ...) are added by their
// phases (docs/02-ARCHITECTURE.md#worker-modullari); the queues themselves are registered now.
@Module({})
export class WorkerModule {
  // Config is passed in (parsed in main.ts) so booting never depends on ambient process.env.
  static register(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        WorkerConfigModule.forRoot(config),
        PrismaModule,
        RedisModule,
        QueueModule,
        HeartbeatModule,
      ],
    };
  }
}
